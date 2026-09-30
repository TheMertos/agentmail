import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteMailStore } from '../src/storage/sqlite-store.mjs';
import { SyncJobRegistry } from '../src/mail/sync-job-registry.mjs';

test('enqueue returns jobId and queued state without blocking', () => {
  const registry = new SyncJobRegistry();
  const job = registry.enqueue('acct-a', { mode: 'incremental' });
  assert.equal(typeof job.jobId, 'string');
  assert.match(job.jobId, /^[0-9a-f-]{36}$/i);
  assert.equal(job.accountId, 'acct-a');
  assert.equal(job.mode, 'incremental');
  assert.equal(job.state, 'queued');
  assert.equal(job.startedAt, null);
  assert.equal(job.completedAt, null);
  assert.equal(job.error, null);
  assert.equal(job.reused, false);
});

test('duplicate enqueue for same account reuses active job', () => {
  const registry = new SyncJobRegistry();
  const first = registry.enqueue('acct-a', { mode: 'full' });
  registry.markRunning(first.jobId);
  const second = registry.enqueue('acct-a', { mode: 'incremental' });
  assert.equal(second.jobId, first.jobId);
  assert.equal(second.reused, true);
  assert.equal(second.state, 'running');
});

test('job status transitions queued running completed', () => {
  const registry = new SyncJobRegistry();
  const job = registry.enqueue('acct-a', { mode: 'incremental' });
  registry.markRunning(job.jobId);
  const running = registry.getForAccount('acct-a');
  assert.equal(running.state, 'running');
  assert.equal(typeof running.startedAt, 'string');
  registry.markCompleted(job.jobId);
  const done = registry.getForAccount('acct-a');
  assert.equal(done.state, 'completed');
  assert.equal(typeof done.completedAt, 'string');
  assert.equal(done.error, null);
});

test('markFailed records error and completedAt', () => {
  const registry = new SyncJobRegistry();
  const job = registry.enqueue('acct-a', { mode: 'full' });
  registry.markRunning(job.jobId);
  registry.markFailed(job.jobId, 'imap_timeout');
  const failed = registry.getForAccount('acct-a');
  assert.equal(failed.state, 'failed');
  assert.equal(failed.error, 'imap_timeout');
  assert.equal(typeof failed.completedAt, 'string');
});

test('after completed job a new enqueue creates a fresh job', () => {
  const registry = new SyncJobRegistry();
  const first = registry.enqueue('acct-a', { mode: 'incremental' });
  registry.markRunning(first.jobId);
  registry.markCompleted(first.jobId);
  const second = registry.enqueue('acct-a', { mode: 'incremental' });
  assert.notEqual(second.jobId, first.jobId);
  assert.equal(second.reused, false);
  assert.equal(second.state, 'queued');
});

test('persisted registry recovers last job per account after restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentmail-sync-jobs-'));
  const dbPath = join(dir, 'mail.db');
  const store = new SqliteMailStore(dbPath);
  const before = new SyncJobRegistry({ store });
  const job = before.enqueue('acct-a', { mode: 'incremental' });
  before.markRunning(job.jobId);
  store.close();

  const store2 = new SqliteMailStore(dbPath);
  const after = new SyncJobRegistry({ store: store2 });
  after.recoverInterruptedJobs();
  const recovered = after.getForAccount('acct-a');
  assert.equal(recovered.jobId, job.jobId);
  assert.equal(recovered.state, 'failed');
  assert.match(recovered.error, /interrupt|restart/i);
  store2.close();
  rmSync(dir, { recursive: true, force: true });
});
