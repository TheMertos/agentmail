import test from 'node:test';
import assert from 'node:assert/strict';
import { syncAccount } from '../src/mail/sync-engine.mjs';

function memoryStore() {
  const folders = new Map();
  const messages = new Map();
  const checkpoints = new Map();
  return {
    folders,
    messages,
    checkpoints,
    async upsertFolder(folder) { folders.set(folder.id, folder); },
    async upsertMessage(message) { messages.set(message.key, message); },
    async getCheckpoint(accountId, mailboxId) {
      return checkpoints.get(`${accountId}:${mailboxId}`) ?? null;
    },
    async checkpoint(data) {
      const key = `${data.accountId}:${data.mailboxId}`;
      const prev = checkpoints.get(key) ?? {};
      checkpoints.set(key, { ...prev, ...data, updatedAt: data.updatedAt ?? new Date().toISOString() });
    },
    countLocal(accountId, mailboxId) {
      return [...messages.values()].filter((m) => m.accountId === accountId && m.mailboxId === mailboxId).length;
    },
    countMessagesInMailbox(accountId, mailboxId) {
      return [...messages.values()].filter((m) => m.accountId === accountId && m.mailboxId === mailboxId).length;
    },
    async clearMailboxMessages(accountId, mailboxId) {
      for (const key of [...messages.keys()]) {
        const message = messages.get(key);
        if (message.accountId === accountId && message.mailboxId === mailboxId) messages.delete(key);
      }
    }
  };
}

test('sync checkpoints after every message batch not only after folder completes', async () => {
  const db = memoryStore();
  const checkpointCalls = [];
  const wrapped = {
    ...db,
    async checkpoint(data) {
      checkpointCalls.push(data);
      return db.checkpoint(data);
    }
  };
  let fetchCalls = 0;
  const provider = {
    async listMailboxes() {
      return [{ id: 'inbox', path: 'INBOX', messages: 5, uidNext: 6, uidValidity: 'v1' }];
    },
    async *fetchMessages(mailbox, { checkpoint, batchSize = 2 }) {
      fetchCalls += 1;
      const start = checkpoint?.lastUid ? checkpoint.lastUid + 1 : 1;
      const end = Math.min(start + batchSize - 1, 5);
      for (let uid = start; uid <= end; uid += 1) {
        yield { uid, uidValidity: 'v1', folderId: mailbox.id, raw: `m${uid}`, flags: [], attachments: [] };
      }
    }
  };
  await syncAccount({ accountId: 'a', provider, store: wrapped, mode: 'full', batchSize: 2 });
  assert.ok(checkpointCalls.length >= 3, `expected per-batch checkpoints, got ${checkpointCalls.length}`);
  assert.equal(db.messages.size, 5);
  const last = checkpointCalls[checkpointCalls.length - 1];
  assert.equal(last.lastUid, 5);
  assert.equal(last.status, 'completed');
});

test('crash resume continues from last persisted UID without restarting at 1', async () => {
  const db = memoryStore();
  await db.checkpoint({
    accountId: 'a',
    mailboxId: 'inbox',
    mode: 'full',
    lastUid: 4,
    uidValidity: 'v1',
    status: 'syncing',
    remoteMessages: 10,
    uidNext: 11
  });
  for (let uid = 1; uid <= 4; uid += 1) {
    await db.upsertMessage({
      accountId: 'a',
      mailboxId: 'inbox',
      key: `a:inbox:v1:${uid}`,
      uid,
      uidValidity: 'v1',
      raw: `m${uid}`,
      flags: [],
      attachments: []
    });
  }
  const fetchedFrom = [];
  const provider = {
    async listMailboxes() {
      return [{ id: 'inbox', path: 'INBOX', messages: 10, uidNext: 11, uidValidity: 'v1' }];
    },
    async *fetchMessages(_mailbox, { checkpoint }) {
      fetchedFrom.push(checkpoint?.lastUid ?? 0);
      const start = (checkpoint?.lastUid ?? 0) + 1;
      for (let uid = start; uid <= 10; uid += 1) {
        yield { uid, uidValidity: 'v1', folderId: 'inbox', raw: `m${uid}`, flags: [], attachments: [] };
      }
    }
  };
  await syncAccount({ accountId: 'a', provider, store: db, mode: 'full', batchSize: 100 });
  assert.deepEqual(fetchedFrom[0], 4);
  assert.equal(db.messages.size, 10);
});

test('UIDVALIDITY change resets only the affected mailbox checkpoint', async () => {
  const db = memoryStore();
  await db.checkpoint({
    accountId: 'a',
    mailboxId: 'inbox',
    lastUid: 50,
    uidValidity: 'old',
    status: 'completed',
    remoteMessages: 50,
    uidNext: 51
  });
  await db.checkpoint({
    accountId: 'a',
    mailboxId: 'sent',
    lastUid: 7,
    uidValidity: 's1',
    status: 'completed',
    remoteMessages: 7,
    uidNext: 8
  });
  await db.upsertMessage({
    accountId: 'a',
    mailboxId: 'inbox',
    key: 'a:inbox:old:1',
    uid: 1,
    uidValidity: 'old',
    raw: 'old',
    flags: [],
    attachments: []
  });
  const provider = {
    async listMailboxes() {
      return [
        { id: 'inbox', path: 'INBOX', messages: 2, uidNext: 3, uidValidity: 'new' },
        { id: 'sent', path: 'Sent', messages: 7, uidNext: 8, uidValidity: 's1' }
      ];
    },
    async *fetchMessages(folder, { checkpoint } = {}) {
      const start = checkpoint?.lastUid ? checkpoint.lastUid + 1 : 1;
      if (folder.id === 'inbox') {
        for (const uid of [1, 2]) {
          if (uid >= start) yield { uid, uidValidity: 'new', folderId: 'inbox', raw: `n${uid}`, flags: [], attachments: [] };
        }
        return;
      }
      if (folder.id === 'sent' && start <= 7) {
        yield { uid: 7, uidValidity: 's1', folderId: 'sent', raw: 's7', flags: [], attachments: [] };
      }
    }
  };
  await syncAccount({ accountId: 'a', provider, store: db, mode: 'incremental', batchSize: 10 });
  const inboxCp = await db.getCheckpoint('a', 'inbox');
  const sentCp = await db.getCheckpoint('a', 'sent');
  assert.equal(inboxCp.uidValidity, 'new');
  assert.equal(inboxCp.lastUid, 2);
  assert.equal(sentCp.lastUid, 7);
  assert.equal([...db.messages.keys()].filter((k) => k.startsWith('a:inbox:')).length, 2);
  assert.ok(!db.messages.has('a:inbox:old:1'));
});

test('incremental sync skips completed mailbox when uidNext unchanged', async () => {
  const db = memoryStore();
  await db.checkpoint({
    accountId: 'a',
    mailboxId: 'inbox',
    lastUid: 5,
    uidValidity: 'v1',
    status: 'completed',
    remoteMessages: 5,
    uidNext: 6
  });
  let fetchCount = 0;
  const provider = {
    async listMailboxes() {
      return [{ id: 'inbox', path: 'INBOX', messages: 5, uidNext: 6, uidValidity: 'v1' }];
    },
    async *fetchMessages() {
      fetchCount += 1;
      yield { uid: 1, uidValidity: 'v1', folderId: 'inbox', raw: 'x', flags: [], attachments: [] };
    }
  };
  const result = await syncAccount({ accountId: 'a', provider, store: db, mode: 'incremental', batchSize: 10 });
  assert.equal(fetchCount, 0);
  assert.equal(result.skippedFolders, 1);
});
