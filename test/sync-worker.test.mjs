import test from 'node:test';
import assert from 'node:assert/strict';
import { SyncWorker } from '../src/mail/sync-worker.mjs';

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
