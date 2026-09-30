import test from 'node:test';
import assert from 'node:assert/strict';
import { startDurableSyncWorker } from '../src/worker/durable-sync.mjs';

test('worker keeps its own interval after a sync failure', async () => {
  const calls = [];
  const { stop } = startDurableSyncWorker({
    config: { syncIntervalSeconds: 0.05 },
    registry: {
      list: () => [{ id: 'a' }],
      get: (id) => (id === 'a' ? { id: 'a' } : undefined)
    },
    mailService: {
      syncAccount: async (accountId) => {
        calls.push(accountId);
        if (calls.length === 1) throw new Error('imap_disconnect');
        return { accountId, folders: [] };
      }
    },
    store: {}
  });

  try {
    const outcome = await Promise.race([
      new Promise((resolve) => {
        const timer = setInterval(() => {
          if (calls.length >= 2) {
            clearInterval(timer);
            resolve('done');
          }
        }, 10);
      }),
      new Promise((resolve) => setTimeout(() => resolve('hung'), 1000))
    ]);
    assert.equal(outcome, 'done');
    assert.ok(calls.length >= 2);
    assert.ok(calls.every((accountId) => accountId === 'a'));
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
