import { accountSyncProgress, folderSyncProgress, NO_CHECKPOINT_PERCENTAGE_REASON } from './sync-progress.mjs';
import { isMailboxSyncComplete, isSelectableMailbox } from './mailbox-sync.mjs';

/**
 * Build MCP-facing sync status for one account from store checkpoints.
 * @param {import('../storage/sqlite-store.mjs').SqliteMailStore} store Mail store.
 * @param {string} accountId Account identifier.
 * @param {object|null} [syncJob] Optional background sync job record.
 * @returns {object} Status payload for the account.
 */
function attachSyncJob(payload, syncJob) {
  if (!syncJob) return payload;
  return {
    ...payload,
    job: {
      jobId: syncJob.jobId,
      state: syncJob.state,
      mode: syncJob.mode,
      startedAt: syncJob.startedAt ?? null,
      completedAt: syncJob.completedAt ?? null,
      error: syncJob.error ?? null
    }
  };
}

export function buildSyncStatus(store, accountId, syncJob = null) {
  const checkpointRows = store.listSyncCheckpoints(accountId);
  if (checkpointRows.length === 0) {
    return attachSyncJob({
      accountId,
      state: 'not_started',
      folders: [],
      downloadedCount: store.countMessages(accountId),
      remoteCount: null,
      remaining: null,
      percentage: null,
      percentageReason: NO_CHECKPOINT_PERCENTAGE_REASON
    }, syncJob);
  }

  const folders = checkpointRows.map((row) => {
    const folderMeta = store.getFolderMetadata?.(accountId, row.mailboxId) ?? null;
    const selectable = folderMeta ? isSelectableMailbox(folderMeta) : true;
    const localCount = row.localMessageCount ?? store.countMessagesInMailbox(accountId, row.mailboxId);
    const syncComplete = isMailboxSyncComplete({
      lastUid: row.lastUid,
      uidNext: row.uidNext,
      remoteMessages: row.remoteMessages,
      localMessageCount: localCount
    });
    const state = syncComplete ? 'completed' : (row.status === 'completed' ? 'syncing' : (row.status ?? 'unknown'));
    const folderProgress = folderSyncProgress({
      remoteMessages: row.remoteMessages,
      localCount,
      uidNext: row.uidNext,
      lastUid: row.lastUid,
      state
    });
    return {
      folderId: row.mailboxId,
      path: store.getFolderPath(accountId, row.mailboxId),
      selectable,
      remoteCount: row.remoteMessages,
      localCount,
      downloadedCount: folderProgress.downloadedCount,
      remaining: folderProgress.remaining,
      percentage: folderProgress.percentage,
      percentageReason: folderProgress.percentageReason,
      state,
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
    localCount: f.localCount,
    selectable: f.selectable
  })));

  return attachSyncJob({
    accountId,
    folders,
    downloadedCount: accountProgress.downloadedCount,
    remoteCount: accountProgress.remoteCount,
    remaining: accountProgress.remaining,
    percentage: accountProgress.percentage,
    percentageReason: accountProgress.percentageReason
  }, syncJob);
}

/**
 * Build sync status for every active account.
 * @param {import('../storage/sqlite-store.mjs').SqliteMailStore} store Mail store.
 * @param {(accountId: string) => object|null} [getJobForAccount]
 * @param {string[]|null} [accountIds] Optional scoped account ids.
 * @returns {{ accounts: object[] }}
 */
export function buildSyncStatusAll(store, getJobForAccount = () => null, accountIds = null) {
  const ids = accountIds ?? store.listActiveAccounts().map((account) => account.id);
  const accounts = ids.map((accountId) => {
    const job = getJobForAccount(accountId);
    return buildSyncStatus(store, accountId, job);
  });
  return { accounts };
}
