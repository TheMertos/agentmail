/**
 * Compute per-folder sync progress from remote and local counts.
 * @param {object} input Folder sync counters and state.
 * @returns {object} Progress fields including nullable percentage.
 */
export function folderSyncProgress(input) {
  const localCount = Number(input.localCount ?? 0);
  const remoteMessages = input.remoteMessages == null ? null : Number(input.remoteMessages);
  const downloadedCount = localCount;
  let remaining = null;
  let percentage = null;
  let percentageReason;

  if (remoteMessages != null && !Number.isNaN(remoteMessages) && remoteMessages >= 0) {
    remaining = Math.max(0, remoteMessages - downloadedCount);
    percentage = remoteMessages === 0 ? 100 : Math.min(100, Math.round((downloadedCount / remoteMessages) * 100));
  } else {
    percentageReason = 'remote total unavailable from provider';
  }

  return {
    downloadedCount,
    remaining,
    percentage,
    percentageReason,
    state: input.state ?? 'unknown'
  };
}

/**
 * Aggregate account-level progress; never guess when any folder lacks a reliable total.
 * @param {object[]} folders Per-folder progress inputs.
 * @returns {object} Account totals and nullable percentage.
 */
export function accountSyncProgress(folders) {
  let downloadedCount = 0;
  let remoteCount = 0;
  let unreliableFolder = null;

  for (const folder of folders) {
    const localCount = Number(folder.localCount ?? 0);
    downloadedCount += localCount;
    const remote = folder.remoteMessages;
    if (remote == null || Number.isNaN(Number(remote))) {
      unreliableFolder = folder.folderId ?? folder.mailboxId ?? 'folder';
      continue;
    }
    remoteCount += Number(remote);
  }

  if (unreliableFolder) {
    return {
      downloadedCount,
      remoteCount: null,
      remaining: null,
      percentage: null,
      percentageReason: `remote total unavailable for ${unreliableFolder}`
    };
  }

  const remaining = Math.max(0, remoteCount - downloadedCount);
  const percentage = remoteCount === 0 ? 100 : Math.min(100, Math.round((downloadedCount / remoteCount) * 100));
  return { downloadedCount, remoteCount, remaining, percentage };
}
