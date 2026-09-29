import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteMailStore } from '../src/storage/sqlite-store.mjs';

test('local mirror searches and reads complete messages by exact key', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentmail-search-'));
  const store = new SqliteMailStore(join(dir, 'mail.db'));
  await store.upsertMessage({ accountId: 'info', mailboxId: 'inbox', key: 'info:inbox:v1:1', uid: 1, uidValidity: 'v1', raw: 'Subject: Project\n\nKubernetes offer', envelope: { subject: 'Project offer', from: [{ address: 'a@example.test' }] }, flags: [], attachments: [] });
  assert.equal(store.searchMessages('info', 'kubernetes', 10).length, 1);
  assert.equal(store.getMessage('info:inbox:v1:1').raw.includes('Kubernetes'), true);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});
