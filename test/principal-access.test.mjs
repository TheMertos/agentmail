import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteMailStore } from '../src/storage/sqlite-store.mjs';
import { createPrincipalRegistry } from '../src/security/principal-scope.mjs';
import { createSyncStatusHandlers } from '../src/mcp/sync-status-tools.mjs';

const ACCOUNT = {
  id: 'gmail',
  email: 'mert@example.test',
  provider: 'gmail',
  secretRef: 'resource-gmail',
  connection: { host: 'imap.gmail.com' }
};

test('legacy account without owner is invisible until claimed by the current principal', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentmail-principal-'));
  const store = new SqliteMailStore(join(dir, 'mail.db'));
  store.activateAccountLegacy(ACCOUNT);
  const mert = createPrincipalRegistry(store, 'mert');
  assert.equal(mert.status('gmail'), null);
  mert.register(ACCOUNT);
  assert.equal(mert.status('gmail')?.id, 'gmail');
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Read the persisted account row, including fields the public register result hides.
 * @param {SqliteMailStore} store Mail store.
 * @param {string} accountId Account id.
 * @returns {object|undefined}
 */
function accountRow(store, accountId) {
  return store.db.prepare('SELECT secret_ref, connection_json, enabled, owner_principal, updated_at FROM active_accounts WHERE account_id = ?').get(accountId);
}

test('cross-principal cannot see or register over an owned account', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentmail-principal-'));
  const store = new SqliteMailStore(join(dir, 'mail.db'));
  const mert = createPrincipalRegistry(store, 'mert');
  mert.register(ACCOUNT);
  const other = createPrincipalRegistry(store, 'other-user');
  assert.equal(other.status('gmail'), null);
  const before = accountRow(store, 'gmail');
  assert.throws(() => other.register({
    ...ACCOUNT,
    secretRef: 'stolen-ref',
    connection: { host: 'evil.example' }
  }), /access_denied/);
  assert.throws(() => other.register(ACCOUNT), /access_denied/);
  assert.deepEqual(accountRow(store, 'gmail'), before);
  assert.equal(store.getAccount('gmail').secretRef, 'resource-gmail');
  assert.deepEqual(store.getAccount('gmail').connection, { host: 'imap.gmail.com' });
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('mail_account_register refuses to overwrite secretRef or connection for the same principal', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentmail-principal-'));
  const store = new SqliteMailStore(join(dir, 'mail.db'));
  const mert = createPrincipalRegistry(store, 'mert');
  const registered = mert.register(ACCOUNT);
  assert.equal(registered.secretRef, undefined);
  assert.equal(registered.ownerPrincipal, undefined);
  assert.equal(JSON.stringify(registered).includes('resource-gmail'), false);
  assert.equal(registered.hasCredentialReference, true);
  const before = accountRow(store, 'gmail');
  assert.throws(() => mert.register({ ...ACCOUNT, secretRef: 'replacement-ref' }), /account_update_rejected/);
  assert.throws(() => mert.register({ ...ACCOUNT, connection: { host: 'imap.other.test' } }), /account_update_rejected/);
  assert.throws(() => mert.register({ ...ACCOUNT, email: 'other@example.test' }), /account_update_rejected/);
  assert.deepEqual(accountRow(store, 'gmail'), before);
  const again = mert.register(ACCOUNT);
  assert.equal(again.id, 'gmail');
  assert.deepEqual(accountRow(store, 'gmail'), before);
  store.deactivateAccount('gmail');
  const disabled = accountRow(store, 'gmail');
  mert.register(ACCOUNT);
  assert.deepEqual(accountRow(store, 'gmail'), disabled);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('mail_account_register rejects plaintext connection secrets and does not store them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentmail-principal-'));
  const store = new SqliteMailStore(join(dir, 'mail.db'));
  const mert = createPrincipalRegistry(store, 'mert');
  const password = 'hunter2-register-secret';
  assert.throws(() => mert.register({
    ...ACCOUNT,
    connection: { host: 'imap.gmail.com', password }
  }), /account_metadata_rejected/);
  assert.equal(store.getAccount('gmail'), null);
  assert.equal(JSON.stringify(store.listActiveAccounts()).includes(password), false);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('same principal lists only owned active accounts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentmail-principal-'));
  const store = new SqliteMailStore(join(dir, 'mail.db'));
  const mert = createPrincipalRegistry(store, 'mert');
  mert.register(ACCOUNT);
  mert.register({ ...ACCOUNT, id: 'work', email: 'work@example.test', secretRef: 'ref-work' });
  store.activateAccountLegacy({ id: 'orphan', email: 'orphan@example.test', provider: 'imap', secretRef: 'ref-o' });
  assert.deepEqual(mert.list().map((a) => a.id).sort(), ['gmail', 'work']);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('scoped registry denies message search for another principals account data', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentmail-principal-'));
  const store = new SqliteMailStore(join(dir, 'mail.db'));
  store.activateAccountLegacy(ACCOUNT);
  store.upsertMessage({
    accountId: 'gmail',
    mailboxId: 'inbox',
    key: 'gmail:inbox:v1:1',
    uid: 1,
    uidValidity: 'v1',
    raw: 'secret-body',
    flags: [],
    attachments: []
  });
  const mert = createPrincipalRegistry(store, 'mert');
  assert.throws(() => mert.assertAccountAccess('gmail'), /access_denied/);
  mert.register(ACCOUNT);
  mert.assertAccountAccess('gmail');
  assert.equal(store.searchMessages('gmail', 'secret', 10).length, 1);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('sync_status MCP handler denies cross-principal account access', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentmail-principal-mcp-'));
  const store = new SqliteMailStore(join(dir, 'mail.db'));
  store.activateAccountLegacy(ACCOUNT);
  const mert = createPrincipalRegistry(store, 'mert');
  const { syncStatus } = createSyncStatusHandlers({ store, registry: mert });
  const denied = JSON.parse(syncStatus({ accountId: 'gmail' }).content[0].text);
  assert.equal(denied.error, 'access_denied');
  mert.register(ACCOUNT);
  const ok = JSON.parse(syncStatus({ accountId: 'gmail' }).content[0].text);
  assert.equal(ok.accountId, 'gmail');
  store.close();
  rmSync(dir, { recursive: true, force: true });
});
