import { SyncWorker } from '../mail/sync-worker.mjs';

/**
 * Default mailbox policy until per-account policies are stored in SQLite.
 * @param {string} accountId
 * @param {{ get: (id: string) => object|undefined }} registry Principal-scoped account registry.
 * @returns {{ enabled: boolean, mode: string }}
 */
function defaultPolicyForAccount(accountId, registry) {
  if (!registry.get(accountId)) return { enabled: false, mode: 'incremental' };
  return { enabled: true, mode: 'full-mirror' };
}

/**
 * Start interval sync for enabled accounts via the durable sync job service.
 * @param {{ config: { syncIntervalSeconds: number }, registry: object, syncJobService: object }} deps
 * @returns {{ worker: SyncWorker, stop: () => void }}
 */
export function startDurableSyncWorker({ config, registry, syncJobService }) {
  const policies = {
    get: (accountId) => defaultPolicyForAccount(accountId, registry)
  };

  const worker = new SyncWorker({
    accounts: registry,
    policies,
    intervalMs: config.syncIntervalSeconds * 1000,
    sync: async (accountId, { mode }) => {
      syncJobService.resumeOrphanedActiveJobs();
      const job = syncJobService.startAccountSync(accountId, { mode });
      await syncJobService.waitForJob(job.jobId);
    }
  });

  syncJobService.resumeOrphanedActiveJobs();
  worker.start();
  return {
    worker,
    stop: () => worker.stop()
  };
}
