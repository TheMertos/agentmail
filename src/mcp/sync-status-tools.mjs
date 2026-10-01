const text = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });

/**
 * Status for one account when background sync and IDLE are disabled.
 * Does not read checkpoints, jobs, or message rows.
 * @param {string} accountId Account id.
 * @returns {object} Remote-only status.
 */
export function remoteOnlySyncStatus(accountId) {
  return {
    accountId,
    mode: 'remote-only',
    syncEnabled: false,
    idleEnabled: false,
    state: 'remote_only',
    folders: [],
    downloadedCount: 0,
    remoteCount: null,
    remaining: null,
    percentage: null,
    percentageReason: 'Background sync is disabled. Interactive tools read IMAP directly.'
  };
}

/**
 * MCP handlers for sync_status and sync_status_all.
 * They report that background sync is disabled and never read the local mirror.
 * @param {{ registry: { assertAccountAccess: Function, list: Function } }} deps Principal registry.
 * @returns {{ syncStatus: Function, syncStatusAll: Function }}
 */
export function createSyncStatusHandlers({ registry }) {
  /**
   * Return remote-only status for one account.
   * @param {{ accountId: string }} args Tool input.
   */
  function syncStatus({ accountId }) {
    try {
      registry.assertAccountAccess(accountId);
    } catch {
      return text({ error: 'access_denied' });
    }
    return text(remoteOnlySyncStatus(accountId));
  }

  /** Return remote-only status for every active account visible to the scoped registry. */
  function syncStatusAll() {
    const accounts = registry.list().map((account) => remoteOnlySyncStatus(account.id));
    return text({ accounts, mode: 'remote-only', syncEnabled: false, idleEnabled: false });
  }

  return { syncStatus, syncStatusAll };
}
