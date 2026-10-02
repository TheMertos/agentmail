import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { loadConfig } from '../src/config.mjs';
import { createCredentialCacheHandlers } from '../src/mcp/credential-cache-tools.mjs';
import { createMailRuntime } from '../src/runtime/mail-runtime.mjs';
import { createCredentialCache } from '../src/security/credential-cache.mjs';
import { createCredentialSync } from '../src/security/credential-sync.mjs';
import { TEST_PRINCIPAL } from './test-principal.mjs';

const RESOURCE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PURPOSE = 'imap-sync';
const FIELD_PATHS = ['incoming.username', 'incoming.password'];

/**
 * Create a random cache key and a random credential pair.
 * @returns {{ key: string, username: string, password: string }}
 */
function secretMaterial() {
  return {
    key: randomBytes(32).toString('hex'),
    username: randomBytes(24).toString('hex'),
    password: randomBytes(32).toString('hex')
  };
}

/**
 * Serialize every stored value, including blobs, for leakage checks.
 * @param {import('better-sqlite3').Database} db Open database.
 * @returns {string}
 */
function databaseText(db) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
  const chunks = [];
  for (const table of tables) {
    const rows = db.prepare(`SELECT * FROM ${table.name}`).all();
    for (const row of rows) {
      for (const value of Object.values(row)) {
        if (Buffer.isBuffer(value)) chunks.push(value.toString('utf8'), value.toString('hex'));
        else if (value != null) chunks.push(String(value));
      }
    }
  }
  return chunks.join('\n');
}

/**
 * Build a resolve payload without retaining it in module scope.
 * @param {number} version Resource version.
 * @param {string} username Username.
 * @param {string} password Password.
 * @returns {object}
 */
function resolved(version, username, password) {
  return {
    requestId: 'req',
    resourceId: RESOURCE_ID,
    version,
    expiresInSeconds: 300,
    fields: { 'incoming.username': username, 'incoming.password': password }
  };
}

test('encrypted cache persists and a wrong key fails closed', () => {
  const { key, username, password } = secretMaterial();
  const otherKey = randomBytes(32).toString('hex');
  const dir = mkdtempSync(join(tmpdir(), 'agentmail-cache-'));
  const filename = join(dir, 'cache.db');
  try {
    const first = new Database(filename);
    const cache = createCredentialCache(first, key);
    const status = cache.put({
      accountId: 'a',
      purpose: PURPOSE,
      resourceId: RESOURCE_ID,
      version: 1,
      credentials: { username, password },
      freshUntil: new Date(Date.now() + 60_000).toISOString()
    });
    assert.equal(status.status, 'current');
    assert.equal(status.version, 1);
    assert.equal(JSON.stringify(status).includes(password), false);
    assert.equal(JSON.stringify(status).includes(username), false);
    assert.equal(databaseText(first).includes(password), false);
    assert.equal(databaseText(first).includes(username), false);
    first.close();

    const second = new Database(filename);
    const reopened = createCredentialCache(second, key);
    assert.deepEqual(reopened.read('a', PURPOSE), { username, password });
    const wrong = createCredentialCache(second, otherKey);
    assert.throws(() => wrong.read('a', PURPOSE), /credential_cache_decrypt_failed/);
    assert.equal(databaseText(second).includes(password), false);
    second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reconcile updates a new version and invalidates a deleted resource', async () => {
  const { key, username, password } = secretMaterial();
  const nextPassword = randomBytes(32).toString('hex');
  const db = new Database(':memory:');
  const cache = createCredentialCache(db, key);
  let version = 1;
  let deleted = false;
  const resolveResource = async (request) => {
    assert.equal(request.resourceId, RESOURCE_ID);
    assert.equal(request.purpose, PURPOSE);
    assert.deepEqual(request.fieldPaths, FIELD_PATHS);
    if (deleted) {
      const error = new Error('resource_not_found');
      error.code = 'resource_not_found';
      error.status = 404;
      throw error;
    }
    return resolved(version, username, version === 1 ? password : nextPassword);
  };
  const sync = createCredentialSync({ cache, resolveResource });
  const account = { id: 'a', secretRef: RESOURCE_ID };
  const created = await sync.reconcile({ account, purpose: PURPOSE, fieldPaths: FIELD_PATHS });
  assert.equal(created.reason, 'updated');
  assert.equal(created.status, 'current');
  assert.equal(JSON.stringify(created).includes(password), false);
  version = 2;
  const updated = await sync.reconcile({ account, purpose: PURPOSE, fieldPaths: FIELD_PATHS });
  assert.equal(updated.version, 2);
  assert.equal(updated.reason, 'updated');
  assert.deepEqual(sync.readForProvider('a', PURPOSE), { username, password: nextPassword });
  assert.equal(databaseText(db).includes(password), false);
  assert.equal(databaseText(db).includes(nextPassword), false);
  deleted = true;
  const removed = await sync.reconcile({ account, purpose: PURPOSE, fieldPaths: FIELD_PATHS });
  assert.equal(removed.status, 'invalidated');
  assert.equal(removed.reason, 'deleted');
  assert.equal(removed.version, null);
  assert.throws(() => sync.readForProvider('a', PURPOSE), /credential_cache_unavailable/);
  const row = db.prepare('SELECT ciphertext, nonce FROM credential_cache').get();
  assert.equal(row.ciphertext, null);
  assert.equal(row.nonce, null);
  assert.equal(databaseText(db).includes(nextPassword), false);
  db.close();
});

test('stale cache and failed resolve do not open the provider', async () => {
  const { key, username, password } = secretMaterial();
  const dir = mkdtempSync(join(tmpdir(), 'agentmail-runtime-'));
  const calls = [];
  let mode = 'ok';
  const fetchImpl = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    if (mode === 'delete') return { ok: false, status: 404, json: async () => ({ error: 'resource_not_found' }) };
    if (mode === 'fail') return { ok: false, status: 403, json: async () => ({ error: 'purpose_not_allowed' }) };
    return { ok: true, json: async () => resolved(1, username, password) };
  };
  const runtime = createMailRuntime({
    dbPath: join(dir, 'mail.db'),
    principal: TEST_PRINCIPAL,
    secretFabricPrincipal: TEST_PRINCIPAL,
    secretFabricUrl: 'http://127.0.0.1:9',
    secretFabricApiToken: 'tok',
    credentialCacheKey: key
  }, {
    fetchImpl,
    providerFactory() {
      throw new Error('provider_should_not_open');
    }
  });
  try {
    runtime.registry.register({
      id: 'a',
      email: 'a@example.test',
      provider: 'imap',
      secretRef: RESOURCE_ID,
      connection: { host: 'imap.example.test', port: 993 }
    });
    const handlers = createCredentialCacheHandlers({
      registry: runtime.registry,
      credentialSync: runtime.credentialSync
    });
    const denied = await handlers.credentialCacheReconcile({ accountId: 'missing' });
    assert.deepEqual(denied, { error: 'access_denied' });
    const status = await handlers.credentialCacheReconcile({ accountId: 'a' });
    assert.equal(JSON.stringify(status).includes(password), false);
    assert.equal(JSON.stringify(status).includes(username), false);
    assert.equal(status.entries.every((entry) => entry.status === 'current'), true);
    mode = 'delete';
    await assert.rejects(() => runtime.mailService.listMailboxes('a'), /credential_cache_unavailable/);
    mode = 'fail';
    await assert.rejects(() => runtime.mailService.listMailboxes('a'), /credential_cache_unavailable/);
    assert.equal(calls.every((call) => call.url === 'http://127.0.0.1:9/api/resolve'), true);
    assert.equal(databaseText(runtime.store.db).includes(password), false);
    const cache = createCredentialCache(runtime.store.db, key);
    cache.put({
      accountId: 'a',
      purpose: 'imap-sync',
      resourceId: RESOURCE_ID,
      version: 1,
      credentials: { username, password },
      freshUntil: new Date(Date.now() - 1000).toISOString()
    });
    assert.throws(() => cache.read('a', 'imap-sync'), /credential_cache_stale/);
  } finally {
    runtime.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cache key is required and rejected when missing or malformed', () => {
  const base = {
    AGENTMAIL_DB_PATH: '/data/agentmail.db',
    AGENTMAIL_SYNC_INTERVAL_SECONDS: '300',
    AGENTMAIL_LOG_LEVEL: 'info',
    AGENTMAIL_TRANSPORT: 'stdio',
    AGENTMAIL_PRINCIPAL: 'mert',
    SECRET_FABRIC_PRINCIPAL: 'mert',
    SECRET_FABRIC_URL: 'http://127.0.0.1:3000',
    SECRET_FABRIC_API_TOKEN: 'tok'
  };
  assert.throws(() => loadConfig(base), /CREDENTIAL_CACHE_KEY/);
  assert.throws(() => loadConfig({ ...base, CREDENTIAL_CACHE_KEY: 'short' }), /CREDENTIAL_CACHE_KEY/);
});

test('runtime requires the cache key and does not resolve credentials directly', () => {
  let called = false;
  const fetchImpl = async () => {
    called = true;
    return { ok: false, status: 500, json: async () => ({ error: 'unexpected' }) };
  };
  assert.throws(() => createMailRuntime({
    dbPath: join(tmpdir(), 'agentmail-missing-key.db'),
    principal: TEST_PRINCIPAL,
    secretFabricPrincipal: TEST_PRINCIPAL,
    secretFabricUrl: 'http://127.0.0.1:9',
    secretFabricApiToken: 'tok'
  }, { fetchImpl }), /CREDENTIAL_CACHE_KEY/);
  assert.equal(called, false);
});
