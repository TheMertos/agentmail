import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SqliteMailStore } from '../src/storage/sqlite-store.mjs';
import { createSyncJobService } from '../src/mail/sync-job-service.mjs';
import { startDurableSyncWorker } from '../src/worker/durable-sync.mjs';
import { activateTestAccount } from './test-principal.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/**
 * @param {object} options
 */
function createLifecycleHarness(options = {}) {
  const alivePids = new Set(options.alivePids ?? [1001, 5000]);
  const syncCalls = [];
  let releaseGate;
  const gate = new Promise((resolve) => { releaseGate = resolve; });

  const makeMailService = (pid) => ({
    syncAccount: async (accountId, opts) => {
      syncCalls.push({ accountId, mode: opts.mode, pid });
      if (!options.blockSync) {
        return { accountId, mode: opts.mode, folders: [] };
      }
      await gate;
      return { accountId, mode: opts.mode, folders: [] };
    }
  });

  const isProcessAlive = (pid) => alivePids.has(pid);

  /**
   * @param {number} pid
   * @param {SqliteMailStore} store
   */
  function spawnService(pid, store) {
    return createSyncJobService({
      mailService: makeMailService(pid),
      store,
      processId: pid,
      isProcessAlive
    });
  }

  return {
    spawnService,
    syncCalls,
    alivePids,
    killMcpProcess: () => { alivePids.delete(1001); },
    releaseGate: () => releaseGate?.()
  };
}

test('compose runs the durable sync worker as the container command', () => {
  const compose = readFileSync(join(repoRoot, 'compose.yaml'), 'utf8');
  assert.match(compose, /command:\s*\["node",\s*"src\/worker\/sync-runtime-worker\.mjs"\]/);
  assert.doesNotMatch(compose, /sleep.*infinity/);
  assert.match(compose, /AGENTMAIL_PROFILE/);
  assert.match(compose, /restart:\s*always/);
});

test('durable sync worker starts and runs an initial sync cycle', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentmail-worker-start-'));
  const dbPath = join(dir, 'mail.db');
  const store = new SqliteMailStore(dbPath);
  activateTestAccount(store, { id: 'a', email: 'a@example.test', provider: 'imap', secretRef: 'ref' });

  const syncCalls = [];
  const syncJobService = createSyncJobService({
    mailService: {
      syncAccount: async (accountId, opts) => {
        syncCalls.push({ accountId, mode: opts.mode });
        return { accountId, folders: [] };
      }
    },
    store
  });

  const registry = { list: () => [{ id: 'a' }], get: (id) => (id === 'a' ? { id: 'a' } : undefined) };
  const { stop } = startDurableSyncWorker({
    config: { syncIntervalSeconds: 3600 },
    registry,
    syncJobService
  });

  await new Promise((r) => setImmediate(r));
  assert.equal(syncCalls.length, 1);
  assert.equal(syncCalls[0].accountId, 'a');

  stop();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('worker resumes persisted jobs after MCP exec exits', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentmail-worker-mcp-exit-'));
  const dbPath = join(dir, 'mail.db');
  const store = new SqliteMailStore(dbPath);
  activateTestAccount(store, { id: 'a', email: 'a@example.test', provider: 'imap', secretRef: 'ref' });

  const harness = createLifecycleHarness({ alivePids: new Set([1001, 5000]), blockSync: true });
  const workerService = harness.spawnService(5000, store);
  const mcpService = harness.spawnService(1001, store);

  const started = mcpService.startAccountSync('a', { mode: 'incremental' });
  await new Promise((r) => setImmediate(r));
  assert.equal(mcpService.getJobStatus('a').state, 'running');

  harness.killMcpProcess();
  workerService.resumeOrphanedActiveJobs();
  harness.releaseGate();
  await workerService.waitForJob(started.jobId);

  assert.equal(workerService.getJobStatus('a').state, 'completed');
  assert.ok(harness.syncCalls.some((call) => call.pid === 5000), 'worker process must finish the sync job');

  store.close();
  rmSync(dir, { recursive: true, force: true });
});
