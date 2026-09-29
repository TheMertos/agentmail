import test from 'node:test';
import assert from 'node:assert/strict';
import { syncAccount } from '../src/mail/sync-engine.mjs';

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
