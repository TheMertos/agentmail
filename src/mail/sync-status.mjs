import { accountSyncProgress, folderSyncProgress, NO_CHECKPOINT_PERCENTAGE_REASON } from './sync-progress.mjs';

/**
 * Build MCP-facing sync status for one account from store checkpoints.
 * @param {import('../storage/sqlite-store.mjs').SqliteMailStore} store Mail store.
 * @param {string} accountId Account identifier.
 * @returns {object} Status payload for the account.
 */
export function buildSyncStatus(store, accountId) {
  const checkpointRows = store.listSyncCheckpoints(accountId);
  if (checkpointRows.length === 0) {
    return {
      accountId,
      state: 'not_started',
      folders: [],
      downloadedCount: store.countMessages(accountId),
      remoteCount: null,
      remaining: null,
      percentage: null,
      percentageReason: NO_CHECKPOINT_PERCENTAGE_REASON
    };
  }

  const folders = checkpointRows.map((row) => {
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
