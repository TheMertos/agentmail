import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteMailStore } from '../src/storage/sqlite-store.mjs';
import { createSyncJobService } from '../src/mail/sync-job-service.mjs';

/**
 * @param {object} overrides
 */
function makeService(overrides = {}) {
  const syncCalls = [];
  const mailService = {
    syncAccount: async (accountId, opts) => {
      syncCalls.push({ accountId, mode: opts.mode });
      if (overrides.syncAccount) return overrides.syncAccount(accountId, opts, syncCalls);
      return { accountId, mode: opts.mode, folders: [] };
    }
  };
  const store = overrides.store ?? new SqliteMailStore(':memory:');
  const service = createSyncJobService({ mailService, store });
  return { service, syncCalls, store };
}

test('startAccountSync returns immediately while sync continues in background', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { service, syncCalls } = makeService({
    syncAccount: async () => {
      await gate;
      return { accountId: 'a', folders: [] };
    }
  });

  const started = service.startAccountSync('a', { mode: 'incremental' });
  assert.equal(started.reused, false);
  assert.equal(started.state, 'queued');
  assert.equal(syncCalls.length, 0);

  await new Promise((r) => setImmediate(r));
  assert.equal(syncCalls.length, 1);
  const status = service.getJobStatus('a');
  assert.equal(status.state, 'running');

  release();
  await service.waitForJob(started.jobId);
  assert.equal(service.getJobStatus('a').state, 'completed');
});

test('duplicate startAccountSync reuses the in-flight job', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { service, syncCalls } = makeService({
    syncAccount: async () => {
      await gate;
      return { accountId: 'a', folders: [] };
    }
  });

  const first = service.startAccountSync('a', { mode: 'full' });
  await new Promise((r) => setImmediate(r));
  const second = service.startAccountSync('a', { mode: 'incremental' });
  assert.equal(second.jobId, first.jobId);
  assert.equal(second.reused, true);
  release();
  await service.waitForJob(first.jobId);
  assert.equal(syncCalls.length, 1);
});

test('failed sync records job error state', async () => {
  const { service } = makeService({
    syncAccount: async () => {
      throw new Error('imap_disconnect');
    }
  });
  const job = service.startAccountSync('a', { mode: 'full' });
  await service.waitForJob(job.jobId);
  const status = service.getJobStatus('a');
  assert.equal(status.state, 'failed');
  assert.equal(status.error, 'imap_disconnect');
});

test('checkpoint resume continues from last UID after restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentmail-sync-resume-'));
  const dbPath = join(dir, 'mail.db');
  const store = new SqliteMailStore(dbPath);
  store.activateAccount({ id: 'a', email: 'a@example.test', provider: 'imap', secretRef: 'ref' });
  store.checkpoint({
    accountId: 'a',
    mailboxId: 'inbox',
    mode: 'full',
    lastUid: 40,
    uidValidity: 'v1',
    remoteMessages: 100,
    uidNext: 101,
    localMessageCount: 40,
    status: 'syncing',
    messageCount: 40
  });

  const startUids = [];
  const mailService = {
    syncAccount: async () => {
      const cp = store.getCheckpoint('a', 'inbox');
      startUids.push(cp.lastUid);
      return { accountId: 'a', resumedFrom: cp.lastUid };
    }
  };

  const service = createSyncJobService({ mailService, store });
  const job = service.startAccountSync('a', { mode: 'full' });
  await service.waitForJob(job.jobId);
  assert.deepEqual(startUids, [40]);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('startAllAccountSync enqueues one job per account without awaiting completion', async () => {
  const pending = new Set(['a', 'b']);
  const { service, syncCalls } = makeService({
    syncAccount: async (accountId) => {
      pending.delete(accountId);
      while (pending.size > 0) {
        await new Promise((r) => setTimeout(r, 5));
      }
      return { accountId };
    }
  });

  const result = service.startAllAccountSync(['a', 'b'], { mode: 'incremental' });
  assert.equal(result.jobs.length, 2);
  assert.ok(result.jobs.every((j) => j.state === 'queued' || j.state === 'running'));
  await Promise.all(result.jobs.map((j) => service.waitForJob(j.jobId)));
  assert.deepEqual(syncCalls.map((c) => c.accountId).sort(), ['a', 'b']);
});
