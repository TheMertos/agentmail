import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteMailStore } from '../src/storage/sqlite-store.mjs';
import { buildSyncStatus, buildSyncStatusAll } from '../src/mail/sync-status.mjs';
import { activateTestAccount } from './test-principal.mjs';

test('buildSyncStatus exposes per-folder progress and checkpoint metadata', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentmail-status-'));
  const store = new SqliteMailStore(join(dir, 'mail.db'));
  activateTestAccount(store, { id: 'a', email: 'a@example.test', provider: 'imap', secretRef: 'ref' });
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

test('buildSyncStatus reports not_started when account has no sync checkpoints', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentmail-status-empty-'));
  const store = new SqliteMailStore(join(dir, 'mail.db'));
  activateTestAccount(store, { id: 'a', email: 'a@example.test', provider: 'imap', secretRef: 'ref' });
  await store.upsertMessage({
    accountId: 'a',
    mailboxId: 'inbox',
    key: 'a:inbox:v1:1',
    uid: 1,
    uidValidity: 'v1',
    raw: 'Subject: Hi\n\nBody',
    envelope: { subject: 'Hi' },
    flags: [],
    attachments: []
  });
  const status = buildSyncStatus(store, 'a');
  assert.equal(status.accountId, 'a');
  assert.deepEqual(status.folders, []);
  assert.equal(status.state, 'not_started');
  assert.equal(status.downloadedCount, 1);
  assert.equal(status.remoteCount, null);
  assert.equal(status.percentage, null);
  assert.match(status.percentageReason, /checkpoint|remote total/i);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('buildSyncStatusAll does not report 100% for accounts without checkpoints', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentmail-status-all-empty-'));
  const store = new SqliteMailStore(join(dir, 'mail.db'));
  activateTestAccount(store, { id: 'a', email: 'a@example.test', provider: 'imap', secretRef: 'ref-a' });
  const all = buildSyncStatusAll(store);
  assert.equal(all.accounts.length, 1);
  assert.equal(all.accounts[0].percentage, null);
  assert.equal(all.accounts[0].state, 'not_started');
  assert.notEqual(all.accounts[0].percentage, 100);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('buildSyncStatusAll lists every active account', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentmail-status-all-'));
  const store = new SqliteMailStore(join(dir, 'mail.db'));
  activateTestAccount(store, { id: 'a', email: 'a@example.test', provider: 'imap', secretRef: 'ref-a' });
  activateTestAccount(store, { id: 'b', email: 'b@example.test', provider: 'imap', secretRef: 'ref-b' });
  store.deactivateAccount('b');
  const all = buildSyncStatusAll(store);
  assert.equal(all.accounts.length, 1);
  assert.equal(all.accounts[0].accountId, 'a');
  store.close();
  rmSync(dir, { recursive: true, force: true });
});
