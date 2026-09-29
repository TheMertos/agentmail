import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteMailStore } from '../src/storage/sqlite-store.mjs';

test('sqlite store persists folders, full raw messages, and checkpoints idempotently', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentmail-'));
  const store = new SqliteMailStore(join(dir, 'mail.db'));
  await store.upsertFolder({ accountId: 'a', id: 'inbox', path: 'INBOX' });
  await store.upsertMessage({ accountId: 'a', mailboxId: 'inbox', key: 'a:inbox:v1:1', uid: 1, uidValidity: 'v1', raw: 'From: a@example.test\r\n\r\nHello', flags: ['\\Seen'], attachments: [] });
  await store.upsertMessage({ accountId: 'a', mailboxId: 'inbox', key: 'a:inbox:v1:1', uid: 1, uidValidity: 'v1', raw: 'From: a@example.test\r\n\r\nUpdated', flags: [], attachments: [] });
  await store.checkpoint({ accountId: 'a', mailboxId: 'inbox', mode: 'full', messageCount: 1 });
  assert.equal(store.countMessages('a'), 1);
  assert.equal(store.getMessage('a:inbox:v1:1').raw.includes('Updated'), true);
  assert.equal(store.getCheckpoint('a', 'inbox').mode, 'full');
  store.close();
  rmSync(dir, { recursive: true, force: true });
});
