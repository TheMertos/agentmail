import { buildSyncStatus, buildSyncStatusAll } from '../mail/sync-status.mjs';

const text = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });

/**
 * Read-only MCP handlers for sync_status and sync_status_all.
 * They report local checkpoint progress and never start or enqueue a sync.
 * @param {{ store: object, registry: { status: Function, list: Function }, syncJobService?: { getJobStatus: Function } }} deps Dependencies.
 * @returns {{ syncStatus: Function, syncStatusAll: Function }}
 */
export function createSyncStatusHandlers({ store, registry, syncJobService }) {
  const jobFor = (accountId) => syncJobService?.getJobStatus?.(accountId) ?? null;

  /**
   * Return sync progress for one account.
   * @param {{ accountId: string }} args Tool input.
   */
  function syncStatus({ accountId }) {
    try {
      registry.assertAccountAccess(accountId);
    } catch {
      return text({ error: 'access_denied' });
    }
    const status = buildSyncStatus(store, accountId, jobFor(accountId));
    return text(status);
  }

  /** Return sync progress for all active accounts visible to the scoped registry. */
  function syncStatusAll() {
    const accountIds = registry.list().map((account) => account.id);
    return text(buildSyncStatusAll(store, jobFor, accountIds));
  }

  return { syncStatus, syncStatusAll };
}
