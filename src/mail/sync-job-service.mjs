import { SyncJobRegistry } from './sync-job-registry.mjs';

/**
 * @param {number} pid
 * @returns {(pid: number) => boolean}
 */
function defaultIsProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Background sync orchestration: enqueue jobs, dedupe per account, run mailService.syncAccount.
 * @param {{ mailService: { syncAccount: Function }, store: import('../storage/sqlite-store.mjs').SqliteMailStore, processId?: number, isProcessAlive?: (pid: number) => boolean }} deps
 */
export function createSyncJobService({ mailService, store, processId = process.pid, isProcessAlive = defaultIsProcessAlive }) {
  const registry = new SyncJobRegistry({ store });

  /** @type {Map<string, { promise: Promise<void>, resolve: Function, reject: Function }>} */
  const waiters = new Map();
  /** @type {Set<string>} */
  const localRuns = new Set();

  /**
   * @param {string} jobId
   * @returns {Promise<void>}
   */
  function ensureWaiter(jobId) {
    let entry = waiters.get(jobId);
    if (!entry) {
      let resolve;
      let reject;
      const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
      });
      entry = { promise, resolve, reject };
      waiters.set(jobId, entry);
    }
    return entry.promise;
  }

  /**
   * @param {string} jobId
   */
  function finishWaiter(jobId) {
    const entry = waiters.get(jobId);
    if (!entry) return;
    entry.resolve();
    waiters.delete(jobId);
  }

  /**
   * @param {string} jobId
   * @param {string} accountId
   * @returns {boolean}
   */
  function tryClaimRunner(jobId, accountId) {
    if (!store?.tryAcquireSyncJobRunner) return true;
    return store.tryAcquireSyncJobRunner({
      accountId,
      jobId,
      pid: processId,
      isProcessAlive
    });
  }

  /**
   * @param {string} jobId
   * @param {string} accountId
   */
  function releaseRunner(jobId, accountId) {
    store?.releaseSyncJobRunner?.({ accountId, jobId, pid: processId });
  }

  /**
   * @param {string} jobId
   * @param {string} accountId
   * @param {string} mode
   */
  async function runJob(jobId, accountId, mode) {
    if (!tryClaimRunner(jobId, accountId)) {
      localRuns.delete(jobId);
      return;
    }
    registry.markRunning(jobId);
    try {
      await mailService.syncAccount(accountId, { mode, store });
      registry.markCompleted(jobId);
      finishWaiter(jobId);
    } catch (error) {
      const message = error?.message ?? String(error);
      registry.markFailed(jobId, message);
      finishWaiter(jobId);
    } finally {
      localRuns.delete(jobId);
      releaseRunner(jobId, accountId);
    }
  }

  /**
   * @param {{ jobId: string, accountId: string, mode: string, reused?: boolean }} job
   * @param {{ resumeOrphan?: boolean }} [options]
   */
  function scheduleJob(job, { resumeOrphan = false } = {}) {
    ensureWaiter(job.jobId);
    if (job.reused && !resumeOrphan) return;
    if (localRuns.has(job.jobId)) return;
    if (!tryClaimRunner(job.jobId, job.accountId)) return;
    localRuns.add(job.jobId);
    setImmediate(() => { void runJob(job.jobId, job.accountId, job.mode); });
  }

  for (const job of registry.hydrateActiveSyncJobs()) {
    scheduleJob(job, { resumeOrphan: true });
  }

  /**
   * @param {string} accountId
   * @param {{ mode?: string }} [options]
   */
  function startAccountSync(accountId, { mode = 'incremental' } = {}) {
    const job = registry.enqueue(accountId, { mode });
    scheduleJob(job);
    return job;
  }

  /**
   * @param {string[]} accountIds
   * @param {{ mode?: string }} [options]
   */
  function startAllAccountSync(accountIds, { mode = 'incremental' } = {}) {
    const jobs = accountIds.map((accountId) => startAccountSync(accountId, { mode }));
    return { mode, jobs };
  }

  /**
   * @param {string} accountId
   */
  function getJobStatus(accountId) {
    return registry.getForAccount(accountId);
  }

  /**
   * @param {string} jobId
   * @returns {Promise<void>}
   */
  function waitForJob(jobId) {
    return ensureWaiter(jobId);
  }

  return {
    registry,
    startAccountSync,
    startAllAccountSync,
    getJobStatus,
    waitForJob
  };
}
