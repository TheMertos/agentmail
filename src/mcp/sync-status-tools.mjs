import { buildSyncStatus, buildSyncStatusAll } from '../mail/sync-status.mjs';

const text = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });

/**
 * MCP handlers for sync_status and sync_status_all tools.
 * @param {{ store: object, registry: { status: Function, list: Function } }} deps Dependencies.
 * @returns {{ syncStatus: Function, syncStatusAll: Function }}
 */
export function createSyncStatusHandlers({ store, registry }) {
  /**
   * Return sync progress for one account.
   * @param {{ accountId: string }} args Tool input.
   */
  function syncStatus({ accountId }) {
    if (!registry.status(accountId)?.enabled) return text({ error: 'account_not_active' });
    const status = buildSyncStatus(store, accountId);
    return text(status);
  }

  /** Return sync progress for all active accounts. */
  function syncStatusAll() {
    return text(buildSyncStatusAll(store));
  }

  return { syncStatus, syncStatusAll };
}
