import { SyncJobRegistry } from './sync-job-registry.mjs';

/**
 * In-process sync bookkeeping.
 * Runs mailService.syncAccount in the same process that called startAccountSync.
 * It does not enqueue work for another process, poll a foreign runner, or adopt a job after some other process exits.
 * The long-lived worker does not use this service; it calls mailService from its own scheduler.
 * @param {{ mailService: { syncAccount: Function }, store: import('../storage/sqlite-store.mjs').SqliteMailStore }} deps Local executor dependencies.
 * @returns {{ registry: SyncJobRegistry, startAccountSync: Function, startAllAccountSync: Function, getJobStatus: Function, waitForJob: Function }}
 */
export function createSyncJobService({ mailService, store }) {
  const registry = new SyncJobRegistry({ store });

  /** @type {Map<string, { promise: Promise<void>, resolve: Function, reject: Function }>} */
  const waiters = new Map();
  /** @type {Set<string>} */
  const localRuns = new Set();

  /**
   * @param {string} jobId Job id.
   * @returns {Promise<void>} Promise that settles when this process finishes the job.
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
   * Resolve waiters for a job that this process already finished.
   * @param {string} jobId Job id.
   */
  function finishWaiter(jobId) {
    const entry = waiters.get(jobId);
    if (!entry) return;
    entry.resolve();
    waiters.delete(jobId);
  }

  /**
   * @param {string} jobId Job id.
   * @returns {boolean} True when the cached job is already completed or failed.
   */
  function settleIfTerminal(jobId) {
    const row = registry.getByJobId(jobId);
    if (!row || (row.state !== 'completed' && row.state !== 'failed')) return false;
    finishWaiter(jobId);
    return true;
  }

  /**
   * Download mail for one job in this process.
   * @param {string} jobId Job id.
   * @param {string} accountId Account id.
   * @param {string} mode Sync mode.
   * @returns {Promise<void>}
   */
  async function runJob(jobId, accountId, mode) {
    registry.markRunning(jobId);
    try {
      await mailService.syncAccount(accountId, { mode, store });
      registry.markCompleted(jobId);
    } catch (error) {
      const message = error?.message ?? String(error);
      registry.markFailed(jobId, message);
    } finally {
      localRuns.delete(jobId);
      finishWaiter(jobId);
    }
  }

  /**
   * Run a queued or running job locally. Already-finished jobs only release waiters.
   * @param {{ jobId: string, accountId: string, mode: string, state?: string }} job Job to run.
   */
  function scheduleJob(job) {
    if (!job?.jobId) return;
    ensureWaiter(job.jobId);
    if (localRuns.has(job.jobId)) return;
    const current = registry.getByJobId(job.jobId) ?? job;
    if (current.state === 'completed' || current.state === 'failed') {
      finishWaiter(job.jobId);
      return;
    }
    localRuns.add(job.jobId);
    setImmediate(() => { void runJob(job.jobId, job.accountId, current.mode ?? job.mode); });
  }

  for (const job of registry.hydrateActiveSyncJobs()) {
    scheduleJob(job);
  }

  /**
   * Queue and run one account sync in this process.
   * @param {string} accountId Account id.
   * @param {{ mode?: string }} [options] Sync mode.
   * @returns {object} Public job view.
   */
  function startAccountSync(accountId, { mode = 'incremental' } = {}) {
    const job = registry.enqueue(accountId, { mode });
    scheduleJob(job);
    return job;
  }

  /**
   * Queue and run a sync for each account in this process.
   * @param {string[]} accountIds Account ids.
   * @param {{ mode?: string }} [options] Sync mode.
   * @returns {{ mode: string, jobs: object[] }} Enqueued jobs.
   */
  function startAllAccountSync(accountIds, { mode = 'incremental' } = {}) {
    const jobs = accountIds.map((accountId) => startAccountSync(accountId, { mode }));
    return { mode, jobs };
  }

  /**
   * Latest job recorded for an account.
   * @param {string} accountId Account id.
   * @returns {object|null} Public job view or null.
   */
  function getJobStatus(accountId) {
    return registry.getForAccount(accountId);
  }

  /**
   * Wait until this process finishes the job.
   * @param {string} jobId Job id.
   * @returns {Promise<void>}
   */
  function waitForJob(jobId) {
    if (settleIfTerminal(jobId)) return Promise.resolve();
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
