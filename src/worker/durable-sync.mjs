import { AccountSyncGate } from '../mail/account-sync-gate.mjs';
import { SyncWorker } from '../mail/sync-worker.mjs';
import { startInboxIdleCoordinator } from './idle-sync.mjs';

/**
 * Default mailbox policy until per-account policies are stored in SQLite.
 * @param {string} accountId Account id.
 * @param {{ get: (id: string) => object|undefined }} registry Principal-scoped account registry.
 * @returns {{ enabled: boolean, mode: string }} Policy for that account.
 */
function defaultPolicyForAccount(accountId, registry) {
  if (!registry.get(accountId)) return { enabled: false, mode: 'incremental' };
  return { enabled: true, mode: 'full-mirror' };
}

/**
 * Start interval mailbox sync and one Inbox IDLE watcher per enabled account.
 * IDLE uses its own connection and lease. The interval scheduler remains the fallback.
 * Each account has one sync lock, shared by IDLE and the scheduler.
 * SecretFabric leases are resolved inside mailService. MCP does not start this work.
 * @param {{ config: { syncIntervalSeconds: number }, registry: object, mailService: { syncAccount: Function, openIdleWatch?: Function }, store: object }} deps Worker dependencies.
 * @param {{ idle?: object }} [options] Test overrides for IDLE timing.
 * @returns {{ worker: SyncWorker, stop: () => Promise<void> }} Running worker and a stop function.
 */
export function startDurableSyncWorker({ config, registry, mailService, store }, options = {}) {
  const policies = {
    get: (accountId) => defaultPolicyForAccount(accountId, registry)
  };
  const gate = new AccountSyncGate();

  /**
   * Sync one account. Concurrent calls for that account run one after another.
   * @param {string} accountId Account id.
   * @param {{ mode?: string }} opts Sync mode.
   * @returns {Promise<unknown>} Sync result.
   */
  function syncAccount(accountId, { mode }) {
    return gate.run(accountId, () => mailService.syncAccount(accountId, { mode, store }));
  }

  const worker = new SyncWorker({
    accounts: registry,
    policies,
    intervalMs: config.syncIntervalSeconds * 1000,
    sync: syncAccount
  });

  worker.start();

  const idle = typeof mailService.openIdleWatch === 'function'
    ? startInboxIdleCoordinator({
      ...options.idle,
      accounts: registry.list(),
      isEnabled: (accountId) => policies.get(accountId)?.enabled !== false,
      openSession: (accountId) => mailService.openIdleWatch(accountId),
      requestSync: (accountId) => syncAccount(accountId, { mode: 'incremental' })
    })
    : { async stop() {} };

  return {
    worker,
    /**
     * Stop the interval scheduler and release every IDLE session.
     * @returns {Promise<void>}
     */
    stop() {
      worker.stop();
      return idle.stop();
    }
  };
}
