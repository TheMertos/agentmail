import { randomUUID } from 'node:crypto';

/**
 * @typedef {object} SyncJobRecord
 * @property {string} jobId
 * @property {string} accountId
 * @property {string} mode
 * @property {'queued'|'running'|'completed'|'failed'} state
 * @property {string|null} startedAt
 * @property {string|null} completedAt
 * @property {string|null} error
 */

/**
 * In-memory per-account sync job registry with optional SQLite durability.
 */
export class SyncJobRegistry {
  /**
   * @param {{ store?: import('../storage/sqlite-store.mjs').SqliteMailStore }} [options]
   */
  constructor({ store } = {}) {
    this.store = store ?? null;
    /** @type {Map<string, SyncJobRecord>} */
    this.byAccount = new Map();
    /** @type {Map<string, SyncJobRecord>} */
    this.byJobId = new Map();
  }

  /**
   * @param {SyncJobRecord} job
   * @returns {object} Public job view with reused flag.
   */
  #toPublic(job, reused = false) {
    return {
      jobId: job.jobId,
      accountId: job.accountId,
      mode: job.mode,
      state: job.state,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      error: job.error,
      reused
    };
  }

  /**
   * @param {SyncJobRecord} job
   */
  #persist(job) {
    this.store?.upsertSyncJob(job);
  }

  /**
   * @param {string} accountId
   * @param {{ mode: string }} options
   * @returns {ReturnType<SyncJobRegistry['#toPublic']>}
   */
  enqueue(accountId, { mode }) {
    const active = this.byAccount.get(accountId);
    if (active && (active.state === 'queued' || active.state === 'running')) {
      return this.#toPublic(active, true);
    }

    const persisted = this.store?.getActiveSyncJobForAccount(accountId);
    if (persisted) {
      this.byAccount.set(accountId, { ...persisted });
      this.byJobId.set(persisted.jobId, { ...persisted });
      return this.#toPublic(persisted, true);
    }

    const job = {
      jobId: randomUUID(),
      accountId,
      mode,
      state: 'queued',
      startedAt: null,
      completedAt: null,
      error: null
    };
    this.byAccount.set(accountId, job);
    this.byJobId.set(job.jobId, job);
    this.#persist(job);
    return this.#toPublic(job, false);
  }

  /**
   * @param {string} jobId
   * @returns {SyncJobRecord|null}
   */
  #get(jobId) {
    return this.byJobId.get(jobId) ?? null;
  }

  /**
   * @param {string} jobId
   */
  markRunning(jobId) {
    const job = this.#get(jobId);
    if (!job) return;
    job.state = 'running';
    job.startedAt = job.startedAt ?? new Date().toISOString();
    this.#persist(job);
  }

  /**
   * @param {string} jobId
   */
  markCompleted(jobId) {
    const job = this.#get(jobId);
    if (!job) return;
    job.state = 'completed';
    job.completedAt = new Date().toISOString();
    job.error = null;
    this.#persist(job);
  }

  /**
   * @param {string} jobId
   * @param {string} error
   */
  markFailed(jobId, error) {
    const job = this.#get(jobId);
    if (!job) return;
    job.state = 'failed';
    job.completedAt = new Date().toISOString();
    job.error = error;
    this.#persist(job);
  }

  /**
   * @param {string} accountId
   * @returns {ReturnType<SyncJobRegistry['#toPublic']>|null}
   */
  getForAccount(accountId) {
    const job = this.byAccount.get(accountId);
    return job ? this.#toPublic(job) : null;
  }

  /**
   * Load queued/running jobs from SQLite without mutating their state.
   * @returns {SyncJobRecord[]}
   */
  hydrateActiveSyncJobs() {
    if (!this.store) return [];
    const active = [];
    for (const row of this.store.listInterruptedSyncJobs()) {
      const job = { ...row };
      this.byAccount.set(job.accountId, job);
      this.byJobId.set(job.jobId, job);
      active.push(job);
    }
    return active;
  }
}
