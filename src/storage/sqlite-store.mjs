import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { assertSafeMetadata } from '../core/account-registry.mjs';
import { extractIncomingAttachments, sanitizeIncomingAttachmentMetadata } from '../mail/incoming-mime.mjs';
import { sanitizeSignatureHtml } from '../core/signatures.mjs';
import { buildMessageSearchPage, compileMessageSearch, normalizeMessageSearch } from '../mail/message-search.mjs';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS active_accounts (
    account_id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    provider TEXT NOT NULL,
    secret_ref TEXT NOT NULL,
    connection_json TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    owner_principal TEXT,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS drafts (
    draft_id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    source_message_key TEXT,
    headers_json TEXT NOT NULL,
    text_body TEXT NOT NULL,
    html_body TEXT NOT NULL,
    attachments_json TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'draft',
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS drafts_account ON drafts(account_id, updated_at);
  CREATE TABLE IF NOT EXISTS staged_attachments (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    owner_principal TEXT NOT NULL,
    filename TEXT NOT NULL,
    content_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    content BLOB NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS staged_attachments_owner ON staged_attachments(account_id, owner_principal);
  CREATE TABLE IF NOT EXISTS signature_profiles (
    profile_id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    name TEXT NOT NULL,
    html_body TEXT NOT NULL,
    text_body TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    enabled INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS signature_profiles_account ON signature_profiles(account_id);
  CREATE TABLE IF NOT EXISTS signature_defaults (
    account_id TEXT PRIMARY KEY,
    profile_id TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS folders (
    account_id TEXT NOT NULL,
    folder_id TEXT NOT NULL,
    path TEXT NOT NULL,
    metadata_json TEXT NOT NULL,
    PRIMARY KEY (account_id, folder_id)
  );
  CREATE TABLE IF NOT EXISTS messages (
    message_key TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    mailbox_id TEXT NOT NULL,
    uid INTEGER NOT NULL,
    uid_validity TEXT NOT NULL,
    internal_date TEXT,
    flags_json TEXT NOT NULL,
    envelope_json TEXT,
    raw_mime TEXT,
    attachments_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS messages_account_mailbox ON messages(account_id, mailbox_id);
  CREATE TABLE IF NOT EXISTS sync_checkpoints (
    account_id TEXT NOT NULL,
    mailbox_id TEXT NOT NULL,
    mode TEXT NOT NULL,
    message_count INTEGER NOT NULL,
    last_uid INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    uid_validity TEXT,
    remote_messages INTEGER,
    uid_next INTEGER,
    local_message_count INTEGER,
    status TEXT,
    started_at TEXT,
    error_class TEXT,
    completed_at TEXT,
    PRIMARY KEY (account_id, mailbox_id)
  );
  CREATE TABLE IF NOT EXISTS sync_jobs (
    job_id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    mode TEXT NOT NULL,
    state TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT,
    error TEXT,
    updated_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS sync_jobs_account_active ON sync_jobs(account_id)
    WHERE state IN ('queued', 'running');
`;

const ACCOUNT_MIGRATIONS = [
  'ALTER TABLE active_accounts ADD COLUMN owner_principal TEXT'
];

const DRAFT_MIGRATIONS = [
  `ALTER TABLE drafts ADD COLUMN attachments_json TEXT NOT NULL DEFAULT '[]'`
];

/**
 * Throw a stable error code with no caller-supplied detail.
 * @param {string} code Stable error code.
 * @returns {Error}
 */
function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

/**
 * Reject plaintext credential fields in connection metadata.
 * @param {object|undefined} connection Non-sensitive connection metadata.
 */
function assertRegisterMetadata(connection) {
  try {
    assertSafeMetadata(connection ?? {}, 'connection');
  } catch {
    throw codedError('account_metadata_rejected');
  }
}

/**
 * Serialize a JSON value with sorted object keys.
 * @param {unknown} value JSON value.
 * @returns {string}
 */
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * Compare identity fields that register must not change.
 * @param {object} existing Stored account.
 * @param {object} account Requested account.
 * @returns {boolean}
 */
function sameStoredAccount(existing, account) {
  return existing.email === account.email
    && existing.provider === account.provider
    && existing.secretRef === account.secretRef
    && stableJson(existing.connection) === stableJson(account.connection ?? {});
}

const CHECKPOINT_MIGRATIONS = [
  'ALTER TABLE sync_checkpoints ADD COLUMN uid_validity TEXT',
  'ALTER TABLE sync_checkpoints ADD COLUMN remote_messages INTEGER',
  'ALTER TABLE sync_checkpoints ADD COLUMN uid_next INTEGER',
  'ALTER TABLE sync_checkpoints ADD COLUMN local_message_count INTEGER',
  'ALTER TABLE sync_checkpoints ADD COLUMN status TEXT',
  'ALTER TABLE sync_checkpoints ADD COLUMN started_at TEXT',
  'ALTER TABLE sync_checkpoints ADD COLUMN error_class TEXT',
  'ALTER TABLE sync_checkpoints ADD COLUMN completed_at TEXT'
];

export class SqliteMailStore {
  constructor(filename = ':memory:') {
    this.db = new Database(filename);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(SCHEMA);
    for (const sql of ACCOUNT_MIGRATIONS) {
      try { this.db.exec(sql); } catch { /* column may already exist */ }
    }
    for (const sql of DRAFT_MIGRATIONS) {
      try { this.db.exec(sql); } catch { /* column may already exist */ }
    }
    for (const sql of CHECKPOINT_MIGRATIONS) {
      try { this.db.exec(sql); } catch { /* column may already exist */ }
    }
    this.accountInsertStatement = this.db.prepare(`INSERT INTO active_accounts(account_id, email, provider, secret_ref, connection_json, enabled, owner_principal, updated_at) VALUES (@id, @email, @provider, @secretRef, @connection, 1, @ownerPrincipal, @updatedAt)`);
    this.accountClaimLegacyStatement = this.db.prepare(`UPDATE active_accounts SET enabled=1, owner_principal=@ownerPrincipal, updated_at=@updatedAt WHERE account_id=@id AND owner_principal IS NULL AND email=@email AND provider=@provider AND secret_ref=@secretRef AND connection_json=@connection`);
    this.accountDisableStatement = this.db.prepare('UPDATE active_accounts SET enabled = 0, updated_at = @updatedAt WHERE account_id = @id');
    this.upsertFolderStatement = this.db.prepare(`INSERT INTO folders(account_id, folder_id, path, metadata_json) VALUES (@accountId, @id, @path, @metadata) ON CONFLICT(account_id, folder_id) DO UPDATE SET path=excluded.path, metadata_json=excluded.metadata_json`);
    this.upsertMessageStatement = this.db.prepare(`INSERT INTO messages(message_key, account_id, mailbox_id, uid, uid_validity, internal_date, flags_json, envelope_json, raw_mime, attachments_json, updated_at) VALUES (@key, @accountId, @mailboxId, @uid, @uidValidity, @internalDate, @flags, @envelope, @raw, @attachments, @updatedAt) ON CONFLICT(message_key) DO UPDATE SET flags_json=excluded.flags_json, internal_date=excluded.internal_date, envelope_json=excluded.envelope_json, raw_mime=excluded.raw_mime, attachments_json=excluded.attachments_json, updated_at=excluded.updated_at`);
    this.checkpointStatement = this.db.prepare(`INSERT INTO sync_checkpoints(account_id, mailbox_id, mode, message_count, last_uid, updated_at, uid_validity, remote_messages, uid_next, local_message_count, status, started_at, error_class, completed_at) VALUES (@accountId, @mailboxId, @mode, @messageCount, @lastUid, @updatedAt, @uidValidity, @remoteMessages, @uidNext, @localMessageCount, @status, @startedAt, @errorClass, @completedAt) ON CONFLICT(account_id, mailbox_id) DO UPDATE SET mode=excluded.mode, message_count=excluded.message_count, last_uid=excluded.last_uid, updated_at=excluded.updated_at, uid_validity=excluded.uid_validity, remote_messages=excluded.remote_messages, uid_next=excluded.uid_next, local_message_count=excluded.local_message_count, status=excluded.status, started_at=COALESCE(sync_checkpoints.started_at, excluded.started_at), error_class=excluded.error_class, completed_at=excluded.completed_at`);
  }

  #mapAccountRow(row) {
    if (!row) return null;
    return {
      id: row.account_id,
      email: row.email,
      provider: row.provider,
      secretRef: row.secret_ref,
      connection: JSON.parse(row.connection_json),
      enabled: Boolean(row.enabled),
      ownerPrincipal: row.owner_principal ?? null
    };
  }

  /**
   * Insert legacy account row without owner (data stays on disk but is not exposed until claimed).
   * @param {object} account Account metadata.
   */
  activateAccountLegacy(account) {
    if (!account?.id || !account.email || !account.provider || !account.secretRef) throw new TypeError('id, email, provider and secretRef are required');
    if (this.getAccount(account.id)) return this.getAccount(account.id);
    this.accountInsertStatement.run({
      id: account.id,
      email: account.email,
      provider: account.provider,
      secretRef: account.secretRef,
      connection: JSON.stringify(account.connection ?? {}),
      ownerPrincipal: null,
      updatedAt: new Date().toISOString()
    });
    return this.getAccount(account.id);
  }

  activateAccount(account) {
    if (!account?.ownerPrincipal) throw new TypeError('ownerPrincipal is required; use activateAccountForPrincipal');
    return this.activateAccountForPrincipal(account, account.ownerPrincipal);
  }

  /**
   * Register an account for the runtime principal.
   * An existing owned row is kept as-is. secretRef, connection, email, and provider changes are rejected.
   * A legacy NULL-owner row can be claimed only when those fields already match.
   * @param {object} account Account metadata.
   * @param {string} ownerPrincipal Trusted runtime principal.
   * @returns {object} Stored account, including the opaque secretRef for in-process use.
   */
  activateAccountForPrincipal(account, ownerPrincipal) {
    if (!account?.id || !account.email || !account.provider || !account.secretRef) throw new TypeError('id, email, provider and secretRef are required');
    if (!ownerPrincipal) throw new TypeError('ownerPrincipal is required');
    assertRegisterMetadata(account.connection);
    const payload = {
      id: account.id,
      email: account.email,
      provider: account.provider,
      secretRef: account.secretRef,
      connection: JSON.stringify(account.connection ?? {}),
      ownerPrincipal,
      updatedAt: new Date().toISOString()
    };
    const existing = this.getAccount(account.id);
    if (!existing) {
      this.accountInsertStatement.run(payload);
      return this.getAccountForPrincipal(account.id, ownerPrincipal);
    }
    if (existing.ownerPrincipal === ownerPrincipal) {
      if (!sameStoredAccount(existing, account)) throw codedError('account_update_rejected');
      return this.getAccountForPrincipal(account.id, ownerPrincipal);
    }
    if (existing.ownerPrincipal === null && sameStoredAccount(existing, account)) {
      const claimed = this.accountClaimLegacyStatement.run(payload);
      if (claimed.changes === 0) throw codedError('access_denied');
      return this.getAccountForPrincipal(account.id, ownerPrincipal);
    }
    throw codedError('access_denied');
  }

  getAccountForPrincipal(id, principal) {
    const row = this.db.prepare('SELECT * FROM active_accounts WHERE account_id = ? AND owner_principal = ?').get(id, principal);
    return this.#mapAccountRow(row);
  }

  listActiveAccountsForPrincipal(principal) {
    return this.db.prepare('SELECT * FROM active_accounts WHERE enabled = 1 AND owner_principal = ? ORDER BY account_id').all(principal)
      .map((row) => this.#mapAccountRow(row));
  }

  deactivateAccount(id) {
    this.accountDisableStatement.run({ id, updatedAt: new Date().toISOString() });
  }

  getAccount(id) {
    const row = this.db.prepare('SELECT * FROM active_accounts WHERE account_id = ?').get(id);
    return this.#mapAccountRow(row);
  }

  listActiveAccounts() {
    return this.db.prepare('SELECT * FROM active_accounts WHERE enabled = 1 ORDER BY account_id').all().map((row) => this.#mapAccountRow(row));
  }

  /**
   * Keep draft attachment metadata without file bytes.
   * @param {Array<object>} [attachments] Staged attachment metadata.
   * @returns {Array<{ id: string, filename: string, contentType: string, size: number, sha256: string }>}
   */
  #draftAttachmentMeta(attachments = []) {
    return attachments.map((item) => ({
      id: item.id,
      filename: item.filename,
      contentType: item.contentType,
      size: item.size,
      sha256: item.sha256
    }));
  }

  createDraft(draft) {
    const id = draft.id ?? randomUUID();
    this.db.prepare(`INSERT INTO drafts(draft_id, account_id, source_message_key, headers_json, text_body, html_body, attachments_json, status, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?)`)
      .run(id, draft.accountId, draft.sourceMessageKey ?? null, JSON.stringify(draft.headers ?? {}), draft.text ?? '', draft.html ?? '', JSON.stringify(this.#draftAttachmentMeta(draft.attachments)), new Date().toISOString());
    return this.getDraft(id);
  }

  getDraft(id) {
    const row = this.db.prepare('SELECT * FROM drafts WHERE draft_id = ?').get(id);
    return row ? { id: row.draft_id, accountId: row.account_id, sourceMessageKey: row.source_message_key, headers: JSON.parse(row.headers_json), text: row.text_body, html: row.html_body, attachments: JSON.parse(row.attachments_json || '[]'), status: row.status, updatedAt: row.updated_at } : null;
  }

  /**
   * Store outgoing attachment bytes for one account and principal.
   * @param {{ accountId: string, ownerPrincipal: string, filename: string, contentType: string, size: number, sha256: string, content: Buffer }} attachment Validated attachment.
   * @returns {{ id: string, filename: string, contentType: string, size: number, sha256: string }}
   */
  stageAttachment(attachment) {
    if (!attachment?.accountId || !attachment.ownerPrincipal || !attachment.filename || !attachment.contentType || !attachment.sha256 || !Buffer.isBuffer(attachment.content)) {
      throw new TypeError('staged attachment fields are required');
    }
    if (attachment.size !== attachment.content.length) throw new TypeError('attachment size mismatch');
    const id = randomUUID();
    this.db.prepare(`INSERT INTO staged_attachments(id, account_id, owner_principal, filename, content_type, size_bytes, sha256, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, attachment.accountId, attachment.ownerPrincipal, attachment.filename, attachment.contentType, attachment.size, attachment.sha256, attachment.content, new Date().toISOString());
    return { id, filename: attachment.filename, contentType: attachment.contentType, size: attachment.size, sha256: attachment.sha256 };
  }

  /**
   * Load staged bytes when they belong to the account and principal.
   * @param {{ id: string, accountId: string, ownerPrincipal: string }} key Attachment identity.
   * @returns {{ id: string, accountId: string, filename: string, contentType: string, size: number, sha256: string, content: Buffer }|null}
   */
  getStagedAttachment({ id, accountId, ownerPrincipal }) {
    const row = this.db.prepare('SELECT * FROM staged_attachments WHERE id = ? AND account_id = ? AND owner_principal = ?').get(id, accountId, ownerPrincipal);
    if (!row) return null;
    return {
      id: row.id,
      accountId: row.account_id,
      filename: row.filename,
      contentType: row.content_type,
      size: row.size_bytes,
      sha256: row.sha256,
      content: Buffer.from(row.content)
    };
  }

  listDrafts(accountId) {
    return this.db.prepare('SELECT draft_id FROM drafts WHERE account_id = ? AND status = \'draft\' ORDER BY updated_at DESC').all(accountId).map(({ draft_id: id }) => this.getDraft(id));
  }

  createSignatureProfile({ accountId, name, html, text }) {
    if (!accountId || !name) throw new TypeError('accountId and name are required');
    const id = randomUUID();
    const safeHtml = sanitizeSignatureHtml(html ?? '');
    this.db.prepare(`INSERT INTO signature_profiles(profile_id, account_id, name, html_body, text_body, version, enabled, updated_at) VALUES (?, ?, ?, ?, ?, 1, 1, ?)`)
      .run(id, accountId, name, safeHtml, text ?? '', new Date().toISOString());
    return this.getSignatureProfile(id);
  }

  updateSignatureProfile(id, { name, html, text, enabled } = {}) {
    const current = this.getSignatureProfile(id);
    if (!current) throw new Error('signature_not_found');
    const nextVersion = current.version + 1;
    const safeHtml = html !== undefined ? sanitizeSignatureHtml(html) : current.html;
    this.db.prepare(`UPDATE signature_profiles SET name = ?, html_body = ?, text_body = ?, version = ?, enabled = ?, updated_at = ? WHERE profile_id = ?`)
      .run(name ?? current.name, safeHtml, text ?? current.text, nextVersion, enabled === undefined ? (current.enabled ? 1 : 0) : (enabled ? 1 : 0), new Date().toISOString(), id);
    return this.getSignatureProfile(id);
  }

  getSignatureProfile(id) {
    const row = this.db.prepare('SELECT * FROM signature_profiles WHERE profile_id = ?').get(id);
    return row ? { id: row.profile_id, accountId: row.account_id, name: row.name, html: row.html_body, text: row.text_body, version: row.version, enabled: Boolean(row.enabled) } : null;
  }

  listSignatureProfiles(accountId) {
    return this.db.prepare('SELECT profile_id FROM signature_profiles WHERE account_id = ? AND enabled = 1 ORDER BY name').all(accountId).map(({ profile_id: id }) => this.getSignatureProfile(id));
  }

  setDefaultSignature(accountId, profileId) {
    const profile = this.getSignatureProfile(profileId);
    if (!profile || profile.accountId !== accountId) throw new Error('signature belongs to another account');
    this.db.prepare('INSERT INTO signature_defaults(account_id, profile_id) VALUES (?, ?) ON CONFLICT(account_id) DO UPDATE SET profile_id = excluded.profile_id').run(accountId, profileId);
  }

  getDefaultSignature(accountId) {
    const row = this.db.prepare('SELECT profile_id FROM signature_defaults WHERE account_id = ?').get(accountId);
    return row ? this.getSignatureProfile(row.profile_id) : null;
  }

  resolveSignatureForSend({ accountId, explicitId }) {
    if (explicitId) {
      const profile = this.getSignatureProfile(explicitId);
      if (profile && profile.accountId !== accountId) throw new Error('signature belongs to another account');
      return profile && profile.enabled ? profile : null;
    }
    const profile = this.getDefaultSignature(accountId);
    return profile && profile.enabled ? profile : null;
  }

  async upsertFolder(folder) {
    this.upsertFolderStatement.run({ ...folder, metadata: JSON.stringify(folder) });
  }

  async upsertMessage(message) {
    this.upsertMessageStatement.run({
      key: message.key,
      accountId: message.accountId,
      mailboxId: message.mailboxId,
      uid: message.uid,
      uidValidity: message.uidValidity,
      internalDate: message.internalDate ?? null,
      ...message,
      flags: JSON.stringify(message.flags ?? []),
      envelope: JSON.stringify(message.envelope ?? null),
      attachments: JSON.stringify(sanitizeIncomingAttachmentMetadata(message.attachments ?? [])),
      updatedAt: new Date().toISOString()
    });
  }

  /**
   * Recover metadata for one legacy mirror row without changing its raw MIME.
   * Only rows with an explicitly empty attachment array are eligible.
   * @param {string} key Exact message key.
   * @returns {Promise<boolean>} Whether metadata was persisted.
   */
  async backfillMessageAttachments(key) {
    const row = this.db.prepare('SELECT raw_mime, attachments_json FROM messages WHERE message_key = ?').get(key);
    if (!row || !row.raw_mime) return false;
    let attachments;
    try { attachments = JSON.parse(row.attachments_json ?? '[]'); } catch { return false; }
    if (!Array.isArray(attachments) || attachments.length !== 0) return false;
    const extracted = sanitizeIncomingAttachmentMetadata(await extractIncomingAttachments(row.raw_mime));
    if (extracted.length === 0) return false;
    const result = this.db.prepare(`UPDATE messages SET attachments_json = ?, updated_at = ?
      WHERE message_key = ? AND json_valid(attachments_json) AND json_type(attachments_json) = 'array'
      AND json_array_length(attachments_json) = 0`).run(JSON.stringify(extracted), new Date().toISOString(), key);
    return result.changes === 1;
  }

  /**
   * Bounded maintenance pass for legacy rows with raw MIME and no metadata.
   * @param {string} accountId Account scope.
   * @param {number} [limit=50] Maximum rows to inspect.
   * @returns {Promise<number>} Number of rows updated.
   */
  async backfillEmptyMessageAttachments(accountId, limit = 50) {
    const boundedLimit = Math.max(1, Math.min(200, Number(limit) || 50));
    const rows = this.db.prepare(`SELECT message_key FROM messages
      WHERE account_id = ? AND raw_mime IS NOT NULL AND json_valid(attachments_json)
      AND json_type(attachments_json) = 'array' AND json_array_length(attachments_json) = 0
      ORDER BY updated_at, message_key LIMIT ?`).all(accountId, boundedLimit);
    let updated = 0;
    for (const row of rows) if (await this.backfillMessageAttachments(row.message_key)) updated += 1;
    return updated;
  }

  async checkpoint(checkpoint) {
    this.checkpointStatement.run({
      accountId: checkpoint.accountId,
      mailboxId: checkpoint.mailboxId,
      mode: checkpoint.mode ?? 'incremental',
      messageCount: checkpoint.messageCount ?? checkpoint.localMessageCount ?? 0,
      lastUid: checkpoint.lastUid ?? 0,
      updatedAt: checkpoint.updatedAt ?? new Date().toISOString(),
      uidValidity: checkpoint.uidValidity ?? null,
      remoteMessages: checkpoint.remoteMessages ?? null,
      uidNext: checkpoint.uidNext ?? null,
      localMessageCount: checkpoint.localMessageCount ?? checkpoint.messageCount ?? 0,
      status: checkpoint.status ?? null,
      startedAt: checkpoint.startedAt ?? null,
      errorClass: checkpoint.errorClass ?? null,
      completedAt: checkpoint.completedAt ?? null
    });
  }

  /**
   * Search mirrored messages for one account.
   * Positional calls return a message array. A criteria object returns a page envelope.
   * @param {string|object} accountId Account id, or search criteria.
   * @param {string} [query] Full-text query for a positional call.
   * @param {number} [limit=50] Row cap for a positional call.
   * @returns {object[]|object}
   */
  searchMessages(accountId, query, limit = 50) {
    if (accountId && typeof accountId === 'object') return this.#runMessageSearch(accountId);
    return this.#runMessageSearch({
      accountId,
      query: query == null ? '' : String(query),
      limit
    }, { legacyLimit: true }).items;
  }

  /**
   * Execute a parameterized account-scoped message search.
   * @param {object} criteria Search criteria. Extra fields are ignored.
   * @param {{ legacyLimit?: boolean }} [options] Clamp limits for the positional API.
   * @returns {object} Page envelope.
   */
  #runMessageSearch(criteria, options = {}) {
    const normalized = normalizeMessageSearch(criteria, options);
    const compiled = compileMessageSearch(normalized);
    const rows = this.db.prepare(compiled.listSql).all(...compiled.listParams);
    const total = this.db.prepare(compiled.countSql).get(...compiled.countParams).total;
    return buildMessageSearchPage({ rows, total, normalized });
  }

  /**
   * List messages in one mailbox, preserving the historical array result.
   * @param {string} accountId Account id.
   * @param {string} [mailboxId] Mailbox id. Empty returns the bounded account search.
   * @param {number} [limit=50] Positional search limit applied before the mailbox filter.
   * @returns {object[]}
   */
  listMessages(accountId, mailboxId, limit = 50) {
    return this.searchMessages(accountId, '', limit).filter((message) => !mailboxId || message.mailboxId === mailboxId);
  }

  countMessages(accountId) {
    return this.db.prepare('SELECT COUNT(*) AS count FROM messages WHERE account_id = ?').get(accountId).count;
  }

  countMessagesInMailbox(accountId, mailboxId) {
    return this.db.prepare('SELECT COUNT(*) AS count FROM messages WHERE account_id = ? AND mailbox_id = ?').get(accountId, mailboxId).count;
  }

  /**
   * UIDs already stored for one mailbox, in ascending order.
   * @param {string} accountId Account id.
   * @param {string} mailboxId Mailbox id.
   * @returns {number[]} Stored UIDs. Resume uses this set so those messages are not fetched again.
   */
  listMessageUids(accountId, mailboxId) {
    return this.db.prepare(
      'SELECT uid FROM messages WHERE account_id = ? AND mailbox_id = ? ORDER BY uid'
    ).all(accountId, mailboxId).map((row) => row.uid);
  }

  clearMailboxMessages(accountId, mailboxId) {
    this.db.prepare('DELETE FROM messages WHERE account_id = ? AND mailbox_id = ?').run(accountId, mailboxId);
  }

  listSyncCheckpoints(accountId) {
    return this.db.prepare('SELECT * FROM sync_checkpoints WHERE account_id = ? ORDER BY mailbox_id').all(accountId).map((row) => this.#mapCheckpointRow(row));
  }

  getFolderPath(accountId, folderId) {
    const row = this.db.prepare('SELECT path FROM folders WHERE account_id = ? AND folder_id = ?').get(accountId, folderId);
    return row?.path ?? folderId;
  }

  /**
   * Parsed folder metadata from the local mirror.
   * @param {string} accountId Account id.
   * @param {string} folderId Folder id.
   * @returns {object|null} Folder record or null.
   */
  getFolderMetadata(accountId, folderId) {
    const row = this.db.prepare('SELECT metadata_json FROM folders WHERE account_id = ? AND folder_id = ?').get(accountId, folderId);
    if (!row?.metadata_json) return null;
    try {
      return JSON.parse(row.metadata_json);
    } catch {
      return null;
    }
  }

  #mapCheckpointRow(row) {
    if (!row) return null;
    return {
      accountId: row.account_id,
      mailboxId: row.mailbox_id,
      mode: row.mode,
      messageCount: row.message_count,
      lastUid: row.last_uid,
      uidValidity: row.uid_validity,
      remoteMessages: row.remote_messages,
      uidNext: row.uid_next,
      localMessageCount: row.local_message_count,
      status: row.status,
      startedAt: row.started_at,
      errorClass: row.error_class,
      completedAt: row.completed_at,
      updatedAt: row.updated_at
    };
  }

  getMessage(key) {
    const row = this.db.prepare('SELECT * FROM messages WHERE message_key = ?').get(key);
    if (!row) return null;
    return { ...row, raw: row.raw_mime, flags: JSON.parse(row.flags_json), envelope: JSON.parse(row.envelope_json), attachments: JSON.parse(row.attachments_json) };
  }

  getCheckpoint(accountId, mailboxId) {
    const row = this.db.prepare('SELECT * FROM sync_checkpoints WHERE account_id = ? AND mailbox_id = ?').get(accountId, mailboxId);
    return row ? this.#mapCheckpointRow(row) : null;
  }

  /**
   * Persist or update a background sync job record.
   * @param {object} job Job fields (jobId, accountId, mode, state, startedAt, completedAt, error).
   */
  upsertSyncJob(job) {
    const updatedAt = new Date().toISOString();
    this.db.prepare(`INSERT INTO sync_jobs(job_id, account_id, mode, state, started_at, completed_at, error, updated_at)
      VALUES (@jobId, @accountId, @mode, @state, @startedAt, @completedAt, @error, @updatedAt)
      ON CONFLICT(job_id) DO UPDATE SET
        state = excluded.state,
        started_at = excluded.started_at,
        completed_at = excluded.completed_at,
        error = excluded.error,
        updated_at = excluded.updated_at`)
      .run({
        jobId: job.jobId,
        accountId: job.accountId,
        mode: job.mode,
        state: job.state,
        startedAt: job.startedAt ?? null,
        completedAt: job.completedAt ?? null,
        error: job.error ?? null,
        updatedAt
      });
  }

  /**
   * Latest sync job for an account (any terminal or active state).
   * @param {string} accountId Account id.
   * @returns {object|null} Normalized job or null.
   */
  getLatestSyncJob(accountId) {
    const row = this.db.prepare(
      `SELECT * FROM sync_jobs WHERE account_id = ? ORDER BY updated_at DESC LIMIT 1`
    ).get(accountId);
    return row ? this.#mapSyncJobRow(row) : null;
  }

  /**
   * Jobs still marked queued or running (e.g. after process restart).
   * @returns {object[]}
   */
  listInterruptedSyncJobs() {
    return this.db.prepare(
      `SELECT * FROM sync_jobs WHERE state IN ('queued', 'running') ORDER BY updated_at`
    ).all().map((row) => this.#mapSyncJobRow(row));
  }

  /**
   * Active queued or running job for an account, if any.
   * @param {string} accountId Account id.
   * @returns {object|null}
   */
  getActiveSyncJobForAccount(accountId) {
    const row = this.db.prepare(
      `SELECT * FROM sync_jobs WHERE account_id = ? AND state IN ('queued', 'running') ORDER BY updated_at DESC LIMIT 1`
    ).get(accountId);
    return row ? this.#mapSyncJobRow(row) : null;
  }

  /**
   * Load one sync job by id.
   * @param {string} jobId Job id.
   * @returns {object|null} Normalized job or null.
   */
  getSyncJobById(jobId) {
    const row = this.db.prepare('SELECT * FROM sync_jobs WHERE job_id = ?').get(jobId);
    return row ? this.#mapSyncJobRow(row) : null;
  }

  #mapSyncJobRow(row) {
    return {
      jobId: row.job_id,
      accountId: row.account_id,
      mode: row.mode,
      state: row.state,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      error: row.error
    };
  }

  close() { this.db.close(); }
}
