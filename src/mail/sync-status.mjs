import { accountSyncProgress, folderSyncProgress } from './sync-progress.mjs';

/**
 * Build MCP-facing sync status for one account from store checkpoints.
 * @param {import('../storage/sqlite-store.mjs').SqliteMailStore} store Mail store.
 * @param {string} accountId Account identifier.
 * @returns {object|null} Status payload or null when account has no checkpoints.
 */
export function buildSyncStatus(store, accountId) {
  const folders = store.listSyncCheckpoints(accountId).map((row) => {
    const localCount = row.localMessageCount ?? store.countMessagesInMailbox(accountId, row.mailboxId);
    const folderProgress = folderSyncProgress({
      remoteMessages: row.remoteMessages,
      localCount,
      uidNext: row.uidNext,
      lastUid: row.lastUid,
      state: row.status
    });
    return {
      folderId: row.mailboxId,
      path: store.getFolderPath(accountId, row.mailboxId),
      remoteCount: row.remoteMessages,
      localCount,
      downloadedCount: folderProgress.downloadedCount,
      remaining: folderProgress.remaining,
      percentage: folderProgress.percentage,
      percentageReason: folderProgress.percentageReason,
      state: row.status ?? 'unknown',
      uidValidity: row.uidValidity ?? null,
      uidNext: row.uidNext ?? null,
      lastCheckpoint: {
        lastUid: row.lastUid ?? 0,
        updatedAt: row.updatedAt ?? null,
        mode: row.mode ?? null
      },
      error: row.errorClass ? { class: row.errorClass } : null,
      startedAt: row.startedAt ?? null,
      completedAt: row.completedAt ?? null
    };
  });

  const accountProgress = accountSyncProgress(folders.map((f) => ({
    folderId: f.folderId,
    remoteMessages: f.remoteCount,
    localCount: f.localCount
  })));

  return {
    accountId,
    folders,
    downloadedCount: accountProgress.downloadedCount,
    remoteCount: accountProgress.remoteCount,
    remaining: accountProgress.remaining,
    percentage: accountProgress.percentage,
    percentageReason: accountProgress.percentageReason
  };
}

/**
 * Build sync status for every active account.
 * @param {import('../storage/sqlite-store.mjs').SqliteMailStore} store Mail store.
 * @returns {{ accounts: object[] }}
 */
export function buildSyncStatusAll(store) {
  const accounts = store.listActiveAccounts().map((account) => buildSyncStatus(store, account.id));
  return { accounts };
}
