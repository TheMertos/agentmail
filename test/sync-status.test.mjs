import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteMailStore } from '../src/storage/sqlite-store.mjs';
import { buildSyncStatus, buildSyncStatusAll } from '../src/mail/sync-status.mjs';

test('buildSyncStatus exposes per-folder progress and checkpoint metadata', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentmail-status-'));
  const store = new SqliteMailStore(join(dir, 'mail.db'));
  store.activateAccount({ id: 'a', email: 'a@example.test', provider: 'imap', secretRef: 'ref' });
  store.checkpoint({
    accountId: 'a',
    mailboxId: 'inbox',
    mode: 'incremental',
    lastUid: 25,
    uidValidity: 'v1',
    remoteMessages: 50,
    uidNext: 51,
    localMessageCount: 25,
    status: 'syncing',
    startedAt: '2026-01-01T00:00:00.000Z',
    messageCount: 25
  });
  store.upsertFolder({ accountId: 'a', id: 'inbox', path: 'INBOX' });
  const status = buildSyncStatus(store, 'a');
  assert.equal(status.accountId, 'a');
  assert.equal(status.folders.length, 1);
  const folder = status.folders[0];
  assert.equal(folder.folderId, 'inbox');
  assert.equal(folder.remoteCount, 50);
  assert.equal(folder.localCount, 25);
  assert.equal(folder.downloadedCount, 25);
  assert.equal(folder.percentage, 50);
  assert.equal(folder.state, 'syncing');
  assert.equal(folder.lastCheckpoint.lastUid, 25);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('buildSyncStatusAll lists every active account', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentmail-status-all-'));
  const store = new SqliteMailStore(join(dir, 'mail.db'));
  store.activateAccount({ id: 'a', email: 'a@example.test', provider: 'imap', secretRef: 'ref-a' });
  store.activateAccount({ id: 'b', email: 'b@example.test', provider: 'imap', secretRef: 'ref-b' });
  store.deactivateAccount('b');
  const all = buildSyncStatusAll(store);
  assert.equal(all.accounts.length, 1);
  assert.equal(all.accounts[0].accountId, 'a');
  store.close();
  rmSync(dir, { recursive: true, force: true });
});
