import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteMailStore } from '../src/storage/sqlite-store.mjs';
import { createSyncJobService } from '../src/mail/sync-job-service.mjs';
import { activateTestAccount } from './test-principal.mjs';

/**
 * @param {object} options
 */
function createLifecycleHarness(options = {}) {
  const alivePids = new Set(options.alivePids ?? [1001, 2000]);
  const syncCalls = [];
  let releaseGate;
  const gate = new Promise((resolve) => { releaseGate = resolve; });
  const execGate = new Promise(() => {});

  const makeMailService = (pid) => ({
    syncAccount: async (accountId, opts) => {
      syncCalls.push({ accountId, mode: opts.mode, pid });
      if (!options.blockSync) {
        return { accountId, mode: opts.mode, folders: [] };
      }
      if (pid === 1001 && !options.execUsesSharedGate) await execGate;
      else await gate;
      return { accountId, mode: opts.mode, folders: [] };
    }
  });

  const isProcessAlive = (pid) => alivePids.has(pid);

  /**
   * @param {number} pid Simulated OS process id for docker-exec vs main MCP.
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
    killExecProcess: () => { alivePids.delete(1001); },
    releaseGate: () => releaseGate?.()
  };
}

test('short-lived exec MCP leaves job resumable; main process completes sync', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentmail-exec-lifecycle-'));
  const dbPath = join(dir, 'mail.db');
  const store = new SqliteMailStore(dbPath);
  activateTestAccount(store, { id: 'a', email: 'a@example.test', provider: 'imap', secretRef: 'ref' });

  const harness = createLifecycleHarness({ alivePids: new Set([1001, 2000]), blockSync: true });
  const execService = harness.spawnService(1001, store);

  const started = execService.startAccountSync('a', { mode: 'incremental' });
  assert.equal(started.reused, false);
  await new Promise((r) => setImmediate(r));
  assert.equal(execService.getJobStatus('a').state, 'running');

  harness.killExecProcess();

  const mainStore = new SqliteMailStore(dbPath);
  const mainService = harness.spawnService(2000, mainStore);
  const afterExecExit = mainService.getJobStatus('a');
  assert.equal(afterExecExit.jobId, started.jobId);
  assert.notEqual(afterExecExit.state, 'failed');
  assert.notEqual(afterExecExit.error, 'interrupted_by_restart');

  harness.releaseGate();
  await mainService.waitForJob(started.jobId);
  assert.equal(mainService.getJobStatus('a').state, 'completed');
  assert.equal(harness.syncCalls.filter((call) => call.pid === 2000).length, 1);

  mainStore.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('duplicate mailbox_sync across processes dedupes via SQLite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentmail-exec-dedupe-'));
  const dbPath = join(dir, 'mail.db');
  const store = new SqliteMailStore(dbPath);
  activateTestAccount(store, { id: 'a', email: 'a@example.test', provider: 'imap', secretRef: 'ref' });

  const harness = createLifecycleHarness({ alivePids: new Set([1001, 2000]), blockSync: true, execUsesSharedGate: true });
  const execService = harness.spawnService(1001, store);
  const first = execService.startAccountSync('a', { mode: 'full' });
  await new Promise((r) => setImmediate(r));

  const peerStore = new SqliteMailStore(dbPath);
  const peerService = harness.spawnService(2000, peerStore);
  const second = peerService.startAccountSync('a', { mode: 'incremental' });
  assert.equal(second.jobId, first.jobId);
  assert.equal(second.reused, true);
  assert.equal(peerService.getJobStatus('a').state, 'running');

  harness.releaseGate();
  await execService.waitForJob(first.jobId);
  assert.equal(harness.syncCalls.length, 1);
  assert.equal(execService.getJobStatus('a').state, 'completed');

  peerStore.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});
