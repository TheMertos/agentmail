import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const KEY_PATTERN = /^[0-9a-fA-F]{64}$/;

/**
 * Validate a 32-byte hexadecimal cache key from the runtime environment.
 * @param {string|undefined|null} raw Candidate key.
 * @returns {Buffer} 32-byte key.
 */
export function parseCredentialCacheKey(raw) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!KEY_PATTERN.test(value)) throw new Error('CREDENTIAL_CACHE_KEY must be a 32-byte hexadecimal key');
  return Buffer.from(value, 'hex');
}

/**
 * Encrypt a credential object with AES-256-GCM. The key never leaves the caller.
 * @param {object} value Credential object.
 * @param {Buffer} key 32-byte key.
 * @returns {{ ciphertext: Buffer, nonce: Buffer }}
 */
export function encryptCredentialPayload(value, key) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return { ciphertext: Buffer.concat([body, cipher.getAuthTag()]), nonce };
}

/**
 * Decrypt a credential payload. Authentication failure throws a stable code.
 * @param {Buffer} ciphertext Ciphertext including the GCM tag.
 * @param {Buffer} nonce 12-byte nonce.
 * @param {Buffer} key 32-byte key.
 * @returns {object}
 */
export function decryptCredentialPayload(ciphertext, nonce, key) {
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    const tag = ciphertext.subarray(ciphertext.length - 16);
    const body = ciphertext.subarray(0, ciphertext.length - 16);
    decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8'));
  } catch {
    throw new Error('credential_cache_decrypt_failed');
  }
}

/**
 * Service-owned encrypted credential rows. Plaintext credentials are not columns.
 * @param {import('better-sqlite3').Database} db Open database.
 * @param {string} keyHex Validated runtime cache key.
 * @returns {object} Cache API.
 */
export function createCredentialCache(db, keyHex) {
  const key = parseCredentialCacheKey(keyHex);
  db.exec(`CREATE TABLE IF NOT EXISTS credential_cache (
    account_id TEXT NOT NULL,
    purpose TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    version INTEGER,
    status TEXT NOT NULL,
    ciphertext BLOB,
    nonce BLOB,
    fresh_until TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (account_id, purpose)
  )`);

  const upsert = db.prepare(`INSERT INTO credential_cache(
      account_id, purpose, resource_id, version, status, ciphertext, nonce, fresh_until, updated_at
    ) VALUES (
      @accountId, @purpose, @resourceId, @version, @status, @ciphertext, @nonce, @freshUntil, @updatedAt
    ) ON CONFLICT(account_id, purpose) DO UPDATE SET
      resource_id=excluded.resource_id,
      version=excluded.version,
      status=excluded.status,
      ciphertext=excluded.ciphertext,
      nonce=excluded.nonce,
      fresh_until=excluded.fresh_until,
      updated_at=excluded.updated_at`);

  /**
   * Map one row to non-sensitive status.
   * @param {object|undefined} row SQLite row.
   * @param {string} accountId Account id.
   * @param {string} purpose Lease purpose.
   * @returns {object}
   */
  function publicRow(row, accountId, purpose) {
    if (!row) {
      return { accountId, purpose, resourceId: null, version: null, status: 'missing', freshUntil: null, updatedAt: null };
    }
    return {
      accountId: row.account_id,
      purpose: row.purpose,
      resourceId: row.resource_id,
      version: row.version ?? null,
      status: row.status,
      freshUntil: row.fresh_until ?? null,
      updatedAt: row.updated_at
    };
  }

  return {
    /**
     * Store encrypted credentials for one account purpose.
     * @param {{ accountId: string, purpose: string, resourceId: string, version: number, credentials: object, freshUntil: string }} input Cache write.
     * @returns {object} Public status.
     */
    put(input) {
      const encrypted = encryptCredentialPayload(input.credentials, key);
      const updatedAt = new Date().toISOString();
      upsert.run({
        accountId: input.accountId,
        purpose: input.purpose,
        resourceId: input.resourceId,
        version: input.version,
        status: 'current',
        ciphertext: encrypted.ciphertext,
        nonce: encrypted.nonce,
        freshUntil: input.freshUntil,
        updatedAt
      });
      return this.status(input.accountId, input.purpose);
    },

    /**
     * Remove ciphertext after delete or a failed resolve.
     * @param {string} accountId Account id.
     * @param {string} purpose Lease purpose.
     * @param {string} resourceId Opaque resource id.
     * @returns {object} Public status.
     */
    invalidate(accountId, purpose, resourceId) {
      upsert.run({
        accountId,
        purpose,
        resourceId: resourceId ?? '',
        version: null,
        status: 'invalidated',
        ciphertext: null,
        nonce: null,
        freshUntil: null,
        updatedAt: new Date().toISOString()
      });
      return this.status(accountId, purpose);
    },

    /**
     * Return non-sensitive cache status.
     * @param {string} accountId Account id.
     * @param {string} purpose Lease purpose.
     * @returns {object}
     */
    status(accountId, purpose) {
      const row = db.prepare('SELECT account_id, purpose, resource_id, version, status, fresh_until, updated_at FROM credential_cache WHERE account_id = ? AND purpose = ?').get(accountId, purpose);
      return publicRow(row, accountId, purpose);
    },

    /**
     * List non-sensitive status rows for one account.
     * @param {string} accountId Account id.
     * @returns {object[]}
     */
    listStatus(accountId) {
      return db.prepare(`SELECT account_id, purpose, resource_id, version, status, fresh_until, updated_at
        FROM credential_cache WHERE account_id = ? ORDER BY purpose`).all(accountId)
        .map((row) => publicRow(row, accountId, row.purpose));
    },

    /**
     * Decrypt one current, unexpired credential row for in-process provider use.
     * @param {string} accountId Account id.
     * @param {string} purpose Lease purpose.
     * @param {number} [nowMs] Clock in milliseconds.
     * @returns {{ username: string, password: string }}
     */
    read(accountId, purpose, nowMs = Date.now()) {
      const row = db.prepare('SELECT * FROM credential_cache WHERE account_id = ? AND purpose = ?').get(accountId, purpose);
      if (!row || row.status !== 'current' || !row.ciphertext || !row.nonce) throw new Error('credential_cache_unavailable');
      const freshUntil = Date.parse(row.fresh_until ?? '');
      if (!Number.isFinite(freshUntil) || nowMs >= freshUntil) throw new Error('credential_cache_stale');
      return decryptCredentialPayload(row.ciphertext, row.nonce, key);
    }
  };
}
