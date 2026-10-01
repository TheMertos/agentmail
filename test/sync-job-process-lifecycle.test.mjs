import test from 'node:test';
import assert from 'node:assert/strict';
import { startDurableSyncWorker } from '../src/worker/durable-sync.mjs';

test('disabled worker does not retry sync after a failure because it never starts', async () => {
  const calls = [];
  const { stop, syncEnabled, idleEnabled } = startDurableSyncWorker({
    config: { syncIntervalSeconds: 0.05 },
    registry: {
      list: () => [{ id: 'a' }],
      get: (id) => (id === 'a' ? { id: 'a' } : undefined)
    },
    mailService: {
      syncAccount: async (accountId) => {
        calls.push(accountId);
        throw new Error('imap_disconnect');
      },
      openIdleWatch: async () => {
        calls.push('idle');
      }
    },
    store: {}
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(syncEnabled, false);
    assert.equal(idleEnabled, false);
    assert.deepEqual(calls, []);
  } finally {
    stop();
  }
});

test('worker does not sync an account missing from its registry', async () => {
  const calls = [];
  const { stop } = startDurableSyncWorker({
    config: { syncIntervalSeconds: 3600 },
    registry: {
      list: () => [{ id: 'gone' }],
      get: () => undefined
    },
    mailService: {
      syncAccount: async (accountId) => {
        calls.push(accountId);
      }
    },
    store: {}
  });

  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  stop();
  assert.deepEqual(calls, []);
});
