import { SyncJobRegistry } from './sync-job-registry.mjs';

/**
 * Background sync orchestration: enqueue jobs, dedupe per account, run mailService.syncAccount.
 * @param {{ mailService: { syncAccount: Function }, store: import('../storage/sqlite-store.mjs').SqliteMailStore }} deps
 */
export function createSyncJobService({ mailService, store }) {
  const registry = new SyncJobRegistry({ store });
  registry.recoverInterruptedJobs();

  /** @type {Map<string, { promise: Promise<void>, resolve: Function, reject: Function }>} */
  const waiters = new Map();

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
   * @param {string} mode
   */
  async function runJob(jobId, accountId, mode) {
    registry.markRunning(jobId);
    try {
      await mailService.syncAccount(accountId, { mode, store });
      registry.markCompleted(jobId);
      finishWaiter(jobId);
    } catch (error) {
      const message = error?.message ?? String(error);
      registry.markFailed(jobId, message);
      finishWaiter(jobId);
    }
  }

  /**
   * @param {string} accountId
   * @param {{ mode?: string }} [options]
   */
  function startAccountSync(accountId, { mode = 'incremental' } = {}) {
    const job = registry.enqueue(accountId, { mode });
    ensureWaiter(job.jobId);
    if (!job.reused) {
      setImmediate(() => { void runJob(job.jobId, accountId, mode); });
    }
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
