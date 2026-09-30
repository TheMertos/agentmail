import test from 'node:test';
import assert from 'node:assert/strict';
import { syncAccount } from '../src/mail/sync-engine.mjs';

test('incremental sync does not skip a completed checkpoint with remaining remote messages', async () => {
  const checkpoints = [];
  const messages = [];
  const store = {
    async getCheckpoint() {
      return {
        status: 'completed',
        lastUid: 1,
        uidNext: 3,
        uidValidity: 'v1',
        remoteMessages: 2,
        localMessageCount: 1,
        messageCount: 1
      };
    },
    async upsertFolder() {},
    async upsertMessage(message) { messages.push(message); },
    countMessagesInMailbox() { return 1 + messages.length; },
    async checkpoint(value) { checkpoints.push(value); }
  };
  const provider = {
    async listMailboxes() {
      return [{ id: 'inbox', path: 'INBOX', messages: 2, uidNext: 3, uidValidity: 'v1' }];
    },
    async *fetchMessages() {
      yield { uid: 2, uidValidity: 'v1', raw: 'Subject: missing\\r\\n\\r\\nbody', attachments: [] };
    }
  };

  await syncAccount({ accountId: 'a', provider, store, mode: 'incremental' });

  assert.equal(messages.length, 1);
  assert.ok(checkpoints.some((checkpoint) => checkpoint.status === 'completed'));
});

test('incremental sync passes the folder checkpoint to the provider', async () => {
  let received;
  const store = {
    async getCheckpoint() { return { lastUid: 41, uidValidity: 'v1' }; },
    async upsertFolder() {},
    async upsertMessage() {},
    async checkpoint() {}
  };
  const provider = {
    async listMailboxes() { return [{ id: 'spam', path: 'Spam' }]; },
    async *fetchMessages(_folder, options) { received = options; }
  };
  await syncAccount({ accountId: 'a', provider, store, mode: 'incremental' });
  assert.deepEqual(received.checkpoint, { lastUid: 41, uidValidity: 'v1' });
});
