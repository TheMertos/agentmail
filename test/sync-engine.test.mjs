import test from 'node:test';
import assert from 'node:assert/strict';
import { syncAccount } from '../src/mail/sync-engine.mjs';

function store() {
  const folders = new Map();
  const messages = new Map();
  return {
    folders, messages,
    async upsertFolder(folder) { folders.set(folder.id, folder); },
    async upsertMessage(message) { messages.set(message.key, message); },
    async checkpoint() {}
  };
}

test('full sync mirrors every folder and message', async () => {
  const db = store();
  const provider = {
    async listMailboxes() { return [{ id: 'inbox', path: 'INBOX' }, { id: 'sent', path: 'Sent' }]; },
    async *fetchMessages(folder) {
      yield { uid: folder.id === 'inbox' ? 1 : 7, uidValidity: 'v1', folderId: folder.id, raw: 'From: sender@example.test\r\n\r\nHello', flags: [], attachments: [] };
    }
  };
  const result = await syncAccount({ accountId: 'a1', provider, store: db, mode: 'full' });
  assert.equal(result.folders, 2);
  assert.equal(result.messages, 2);
  assert.equal(db.messages.size, 2);
});

test('re-running sync is idempotent', async () => {
  const db = store();
  const provider = {
    async listMailboxes() { return [{ id: 'inbox', path: 'INBOX' }]; },
    async *fetchMessages() { yield { uid: 1, uidValidity: 'v1', folderId: 'inbox', raw: 'same', flags: [], attachments: [] }; }
  };
  await syncAccount({ accountId: 'a1', provider, store: db, mode: 'full' });
  await syncAccount({ accountId: 'a1', provider, store: db, mode: 'full' });
  assert.equal(db.messages.size, 1);
});
