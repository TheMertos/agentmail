import test from 'node:test';
import assert from 'node:assert/strict';
import { syncAccount } from '../src/mail/sync-engine.mjs';

test('sync-engine fetches bounded UID batches until uidNext is reached', async () => {
  const uidNext = 251;
  const batchSize = 100;
  const fetchCalls = [];
  const messages = new Map();
  const store = {
    async upsertFolder() {},
    async getCheckpoint(accountId, mailboxId) {
      return null;
    },
    async upsertMessage(message) {
      messages.set(message.key, message);
    },
    async checkpoint() {},
    countMessagesInMailbox() {
      return messages.size;
    }
  };

  const provider = {
    async listMailboxes() {
      return [{
        id: 'INBOX',
        path: 'INBOX',
        messages: 250,
        uidNext,
        uidValidity: 'v1'
      }];
    },
    async *fetchMessages(_mailbox, { checkpoint, batchSize: size = batchSize }) {
      const start = checkpoint?.lastUid ? checkpoint.lastUid + 1 : 1;
      const end = Math.min(start + size - 1, uidNext - 1);
      fetchCalls.push({ start, end, lastUid: checkpoint?.lastUid ?? 0 });
      if (start > end) return;
      for (let uid = start; uid <= end; uid += 1) {
        yield {
          uid,
          uidValidity: 'v1',
          folderId: 'INBOX',
          raw: `m${uid}`,
          flags: [],
          attachments: []
        };
      }
    }
  };

  await syncAccount({ accountId: 'a', provider, store, mode: 'full', batchSize });
  assert.equal(fetchCalls.length, 3);
  assert.deepEqual(fetchCalls[0], { start: 1, end: 100, lastUid: 0 });
  assert.deepEqual(fetchCalls[1], { start: 101, end: 200, lastUid: 100 });
  assert.deepEqual(fetchCalls[2], { start: 201, end: 250, lastUid: 200 });
  assert.equal(messages.size, 250);
});
