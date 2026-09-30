import test from 'node:test';
import assert from 'node:assert/strict';
import { SyncWorker } from '../src/mail/sync-worker.mjs';
import { syncAccount } from '../src/mail/sync-engine.mjs';

test('worker syncs every enabled account once and prevents overlap', async () => {
  const calls = [];
  const worker = new SyncWorker({
    accounts: { list: () => [{ id: 'info' }, { id: 'gmail' }] },
    policies: { get: () => ({ enabled: true, mode: 'full-mirror' }) },
    sync: async (id) => { calls.push(id); }
  });
  await Promise.all([worker.runOnce(), worker.runOnce()]);
  assert.deepEqual(calls.sort(), ['gmail', 'info']);
});

test('a slow account does not starve another enabled account', async () => {
  const calls = [];
  const completed = [];
  let releaseSlow;
  const slow = new Promise((resolve) => { releaseSlow = resolve; });
  const worker = new SyncWorker({
    accounts: { list: () => [{ id: 'gmail' }, { id: 'info' }] },
    policies: { get: () => ({ enabled: true, mode: 'incremental' }) },
    sync: async (id) => {
      calls.push(id);
      if (id === 'gmail') await slow;
      completed.push(id);
    }
  });

  const cycle = worker.runOnce();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls.sort(), ['gmail', 'info']);
  assert.deepEqual(completed, ['info']);
  releaseSlow();
  await cycle;
});

test('worker cycle stores a newly delivered message and advances the mailbox checkpoint', async () => {
  const messages = [];
  let checkpoint = {
    status: 'completed',
    lastUid: 846,
    uidNext: 847,
    uidValidity: 'gmail-v1',
    remoteMessages: 841,
    localMessageCount: 841,
    messageCount: 841
  };
  const store = {
    async getCheckpoint() { return checkpoint; },
    async upsertFolder() {},
    async upsertMessage(message) { messages.push(message); },
    countMessagesInMailbox() { return 841 + messages.length; },
    async checkpoint(next) { checkpoint = { ...checkpoint, ...next }; }
  };
  let remoteMessages = 842;
  const provider = {
    async listMailboxes() {
      return [{ id: 'INBOX', path: 'INBOX', flags: [], uidValidity: 'gmail-v1', uidNext: 848, messages: remoteMessages }];
    },
    async *fetchMessages() {
      yield { uid: 847, uidValidity: 'gmail-v1', raw: 'Subject: latest info\\r\\n\\r\\nnew message', flags: [], attachments: [] };
    }
  };
  const worker = new SyncWorker({
    accounts: { list: () => [{ id: 'info' }] },
    policies: { get: () => ({ enabled: true, mode: 'full-mirror' }) },
    sync: (accountId, options) => syncAccount({ accountId, provider, store, mode: options.mode })
  });

  await worker.runOnce();

  assert.equal(messages.length, 1);
  assert.equal(messages[0].uid, 847);
  assert.equal(checkpoint.lastUid, 847);
  assert.equal(checkpoint.uidNext, 848);
  assert.equal(checkpoint.status, 'completed');
});

test('worker records and logs per-account sync errors without exposing credentials', async () => {
  const errors = [];
  const worker = new SyncWorker({
    accounts: { list: () => [{ id: 'info' }] },
    policies: { get: () => ({ enabled: true, mode: 'incremental' }) },
    logger: { error(entry) { errors.push(entry); } },
    sync: async () => { throw new Error('imap failed password=super-secret'); }
  });

  const [result] = await worker.runOnce();

  assert.equal(result.status, 'error');
  assert.equal(result.error, 'imap failed password=[redacted]');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].accountId, 'info');
  assert.equal(errors[0].error, 'imap failed password=[redacted]');
  assert.doesNotMatch(JSON.stringify(errors), /super-secret/);
});
