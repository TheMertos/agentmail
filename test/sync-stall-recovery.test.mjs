import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ImapOperationTimeout } from '../src/mail/imap-provider.mjs';
import { syncAccount } from '../src/mail/sync-engine.mjs';
import { SqliteMailStore } from '../src/storage/sqlite-store.mjs';

const GMAIL_ALL_MAIL = '[Google Mail]/Alle Nachrichten';

/**
 * In-memory store that records checkpoints and UIDs.
 * @returns {object} Store double.
 */
function memoryStore() {
  const messages = new Map();
  const checkpoints = new Map();
  return {
    messages,
    checkpoints,
    async upsertFolder() {},
    async upsertMessage(message) {
      messages.set(message.key, message);
    },
    async getCheckpoint(accountId, mailboxId) {
      return checkpoints.get(`${accountId}:${mailboxId}`) ?? null;
    },
    async checkpoint(data) {
      const key = `${data.accountId}:${data.mailboxId}`;
      checkpoints.set(key, { ...checkpoints.get(key), ...data });
    },
    countMessagesInMailbox(accountId, mailboxId) {
      return [...messages.values()].filter((message) => message.accountId === accountId && message.mailboxId === mailboxId).length;
    },
    listMessageUids(accountId, mailboxId) {
      return [...messages.values()]
        .filter((message) => message.accountId === accountId && message.mailboxId === mailboxId)
        .map((message) => Number(message.uid));
    }
  };
}

test('stalled batch keeps stored messages and resumes after the last UID', async () => {
  const store = memoryStore();
  const starts = [];
  let calls = 0;
  const provider = {
    async listMailboxes() {
      return [{ id: 'INBOX', path: 'INBOX', messages: 3, uidNext: 4, uidValidity: 'v', flags: [] }];
    },
    async *fetchMessages(_mailbox, { checkpoint }) {
      calls += 1;
      const start = Number(checkpoint?.lastUid ?? 0) + 1;
      starts.push(start);
      if (calls === 1) {
        yield { uid: start, uidValidity: 'v', raw: 'one', flags: [], attachments: [] };
        throw new ImapOperationTimeout('fetch');
      }
      for (let uid = start; uid <= 3; uid += 1) {
        yield { uid, uidValidity: 'v', raw: `m${uid}`, flags: [], attachments: [] };
      }
    }
  };

  await syncAccount({ accountId: 'a', provider, store, mode: 'full', batchSize: 10 });

  assert.deepEqual(starts, [1, 2]);
  assert.deepEqual(store.listMessageUids('a', 'INBOX').sort((a, b) => a - b), [1, 2, 3]);
  const checkpoint = await store.getCheckpoint('a', 'INBOX');
  assert.equal(checkpoint.lastUid, 3);
  assert.equal(checkpoint.status, 'completed');
  assert.equal(checkpoint.localMessageCount, 3);
  assert.equal(checkpoint.remoteMessages, 3);
});

test('a UID that times out twice is skipped and later mail still checkpoints', async () => {
  const store = memoryStore();
  const requests = [];
  const provider = {
    async listMailboxes() {
      return [{ id: 'INBOX', path: 'INBOX', messages: 1, uidNext: 3, uidValidity: 'v', flags: [] }];
    },
    async *fetchMessages(_mailbox, { checkpoint, batchSize = 10, onBatchRange }) {
      const start = Number(checkpoint?.lastUid ?? 0) + 1;
      const end = Math.min(start + batchSize - 1, 2);
      onBatchRange?.({ startUid: start, endUid: end });
      requests.push({ start, end });
      if (start === 1) throw new ImapOperationTimeout('fetch');
      yield { uid: 2, uidValidity: 'v', raw: 'kept', flags: [], attachments: [] };
    }
  };

  await syncAccount({ accountId: 'a', provider, store, mode: 'full', batchSize: 10 });

  assert.ok(requests.some((range) => range.start === 1 && range.end === 1));
  assert.ok(requests.some((range) => range.start === 2));
  assert.deepEqual(store.listMessageUids('a', 'INBOX'), [2]);
  const checkpoint = await store.getCheckpoint('a', 'INBOX');
  assert.ok(checkpoint.lastUid >= 2);
  assert.equal(checkpoint.status, 'completed');
  assert.equal(checkpoint.localMessageCount, 1);
});

test('adjacent stalled UIDs stop the mailbox instead of skipping the rest', async () => {
  const store = memoryStore();
  const starts = [];
  const provider = {
    async listMailboxes() {
      return [{ id: 'INBOX', path: 'INBOX', messages: 3, uidNext: 4, uidValidity: 'v', flags: [] }];
    },
    async *fetchMessages(_mailbox, { checkpoint, batchSize = 10, onBatchRange }) {
      const start = Number(checkpoint?.lastUid ?? 0) + 1;
      const end = Math.min(start + batchSize - 1, 3);
      onBatchRange?.({ startUid: start, endUid: end });
      starts.push(start);
      throw new ImapOperationTimeout('fetch');
    }
  };

  await syncAccount({ accountId: 'a', provider, store, mode: 'full', batchSize: 10 });

  assert.equal(starts.includes(3), false);
  const checkpoint = await store.getCheckpoint('a', 'INBOX');
  assert.equal(checkpoint.lastUid, 1);
  assert.equal(checkpoint.status, 'syncing');
  assert.equal(checkpoint.localMessageCount, 0);
  assert.equal(checkpoint.remoteMessages, 3);
});

test('UID search fills holes without downloading stored messages and corrects a stale EXISTS', async () => {
  const store = memoryStore();
  await store.upsertMessage({
    accountId: 'gmail',
    mailboxId: 'INBOX',
    key: 'gmail:INBOX:v:1',
    uid: 1,
    uidValidity: 'v',
    raw: 'have',
    flags: [],
    attachments: []
  });
  await store.checkpoint({
    accountId: 'gmail',
    mailboxId: 'INBOX',
    mode: 'full',
    lastUid: 5,
    uidValidity: 'v',
    remoteMessages: 74_151,
    uidNext: 6,
    localMessageCount: 1,
    status: 'syncing',
    messageCount: 1
  });
  const fetchedUids = [];
  const provider = {
    async listMailboxes() {
      return [{ id: 'INBOX', path: 'INBOX', messages: 74_151, uidNext: 6, uidValidity: 'v', flags: [] }];
    },
    async searchUids() {
      return [1, 4];
    },
    async *fetchMessages(_mailbox, { uids = [] }) {
      for (const uid of uids) {
        fetchedUids.push(uid);
        yield { uid, uidValidity: 'v', raw: `m${uid}`, flags: [], attachments: [] };
      }
    }
  };

  await syncAccount({ accountId: 'gmail', provider, store, mode: 'full', batchSize: 10 });

  assert.deepEqual(fetchedUids, [4]);
  assert.deepEqual(store.listMessageUids('gmail', 'INBOX').sort((a, b) => a - b), [1, 4]);
  const checkpoint = await store.getCheckpoint('gmail', 'INBOX');
  assert.equal(checkpoint.status, 'completed');
  assert.equal(checkpoint.remoteMessages, 2);
  assert.equal(checkpoint.localMessageCount, 2);
  assert.equal(Math.max(0, checkpoint.remoteMessages - checkpoint.localMessageCount), 0);
});

test('completing INBOX does not complete Gmail All Mail', async () => {
  const store = memoryStore();
  const provider = {
    async listMailboxes() {
      return [
        { id: 'INBOX', path: 'INBOX', messages: 1, uidNext: 2, uidValidity: 'in', flags: [] },
        { id: GMAIL_ALL_MAIL, path: GMAIL_ALL_MAIL, messages: 77_292, uidNext: 108_271, uidValidity: 'all', flags: [] }
      ];
    },
    async *fetchMessages(mailbox, { checkpoint }) {
      const start = Number(checkpoint?.lastUid ?? 0) + 1;
      if (mailbox.id === 'INBOX') {
        if (start > 1) return;
        yield { uid: 1, uidValidity: 'in', raw: 'inbox', flags: [], attachments: [] };
        return;
      }
      if (start === 1) {
        yield { uid: 1, uidValidity: 'all', raw: 'all', flags: [], attachments: [] };
      }
    }
  };

  await syncAccount({ accountId: 'gmail', provider, store, mode: 'full', batchSize: 100 });

  const inbox = await store.getCheckpoint('gmail', 'INBOX');
  const allMail = await store.getCheckpoint('gmail', GMAIL_ALL_MAIL);
  assert.equal(inbox.status, 'completed');
  assert.equal(inbox.localMessageCount, 1);
  assert.equal(allMail.status, 'syncing');
  assert.equal(allMail.remoteMessages, 77_292);
  assert.equal(allMail.localMessageCount, 1);
  assert.ok(allMail.lastUid < 108_270);
});

test('sqlite lists stored mailbox UIDs for resume without a second download', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentmail-uids-'));
  const store = new SqliteMailStore(join(dir, 'mail.db'));
  await store.upsertMessage({
    key: 'a:INBOX:v:8',
    accountId: 'a',
    mailboxId: 'INBOX',
    uid: 8,
    uidValidity: 'v',
    raw: 'kept',
    flags: [],
    attachments: []
  });
  assert.deepEqual(store.listMessageUids('a', 'INBOX'), [8]);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});
