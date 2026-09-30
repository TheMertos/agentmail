import { boundedUidRange } from './imap-provider.mjs';
import { isMailboxSyncComplete, isSelectableMailbox } from './mailbox-sync.mjs';

function mailboxRemoteStatus(mailbox) {
  return {
    uidValidity: mailbox.uidValidity != null ? String(mailbox.uidValidity) : null,
    uidNext: mailbox.uidNext != null ? Number(mailbox.uidNext) : null,
    remoteMessages: mailbox.messages != null ? Number(mailbox.messages) : (mailbox.remoteMessages != null ? Number(mailbox.remoteMessages) : null)
  };
}

function isMailboxUpToDate(checkpoint, remote, mode) {
  if (mode !== 'incremental' || !checkpoint) return false;
  if (checkpoint.status !== 'completed') return false;
  if (remote.uidValidity && checkpoint.uidValidity && checkpoint.uidValidity !== remote.uidValidity) return false;
  if (checkpoint.uidNext == null || remote.uidNext == null) return false;
  return checkpoint.uidNext === remote.uidNext;
}

/**
 * Synchronize one account with resumable per-batch checkpoints.
 * @param {object} options accountId, provider, store, mode, batchSize.
 * @returns {Promise<object>} Sync summary.
 */
export async function syncAccount({ accountId, provider, store, mode = 'incremental', batchSize = 100 }) {
  if (!accountId || !provider || !store) throw new TypeError('accountId, provider and store are required');
  const mailboxes = await provider.listMailboxes({ mode });
  let messageCount = 0;
  let skippedMessages = 0;
  let skippedFolders = 0;
  const now = () => new Date().toISOString();

  for (const mailbox of mailboxes) {
    if (!isSelectableMailbox(mailbox)) {
      continue;
    }
    const remote = mailboxRemoteStatus(mailbox);
    let checkpoint = await store.getCheckpoint?.(accountId, mailbox.id);

    if (checkpoint?.uidValidity && remote.uidValidity && checkpoint.uidValidity !== remote.uidValidity) {
      await store.clearMailboxMessages?.(accountId, mailbox.id);
      checkpoint = null;
    }

    if (isMailboxUpToDate(checkpoint, remote, mode)) {
      skippedFolders += 1;
      await store.checkpoint?.({
        accountId,
        mailboxId: mailbox.id,
        mode,
        lastUid: checkpoint.lastUid,
        uidValidity: remote.uidValidity ?? checkpoint.uidValidity,
        remoteMessages: remote.remoteMessages,
        uidNext: remote.uidNext,
        localMessageCount: checkpoint.localMessageCount ?? store.countMessagesInMailbox?.(accountId, mailbox.id) ?? 0,
        status: 'completed',
        startedAt: checkpoint.startedAt,
        completedAt: checkpoint.completedAt ?? now(),
        messageCount: checkpoint.messageCount ?? 0
      });
      continue;
    }

    await store.upsertFolder({ ...mailbox, accountId });
    const startedAt = checkpoint?.startedAt ?? now();
    let lastUid = checkpoint?.lastUid ?? 0;
    let uidValidity = remote.uidValidity ?? checkpoint?.uidValidity ?? null;
    let folderCount = checkpoint?.messageCount ?? 0;

    await store.checkpoint?.({
      accountId,
      mailboxId: mailbox.id,
      mode,
      lastUid,
      uidValidity,
      remoteMessages: remote.remoteMessages,
      uidNext: remote.uidNext,
      localMessageCount: store.countMessagesInMailbox?.(accountId, mailbox.id) ?? folderCount,
      status: 'syncing',
      startedAt,
      messageCount: folderCount
    });

    while (true) {
      if (isMailboxSyncComplete({
        lastUid,
        uidNext: remote.uidNext,
        remoteMessages: remote.remoteMessages,
        localMessageCount: store.countMessagesInMailbox?.(accountId, mailbox.id) ?? folderCount
      })) {
        break;
      }
      const batchStartUid = lastUid + 1;
      const plannedRange = remote.uidNext != null ? boundedUidRange(batchStartUid, batchSize, remote.uidNext) : null;
      if (remote.uidNext != null && !plannedRange) break;

      let batchCount = 0;
      let batchHighUid = lastUid;
      let attemptedRange = null;
      const activeCheckpoint = { lastUid, uidValidity };
      for await (const message of provider.fetchMessages(mailbox, {
        mode,
        checkpoint: activeCheckpoint,
        batchSize,
        onBatchRange: (range) => { attemptedRange = range; }
      })) {
        if (message.uid === undefined || message.uid === null) {
          skippedMessages += 1;
          continue;
        }
        const uidNum = Number(message.uid) || 0;
        if (uidNum <= lastUid) {
          skippedMessages += 1;
          continue;
        }
        uidValidity = message.uidValidity != null ? String(message.uidValidity) : uidValidity;
        const key = `${accountId}:${mailbox.id}:${uidValidity}:${message.uid}`;
        await store.upsertMessage({
          ...message,
          accountId,
          mailboxId: mailbox.id,
          key,
          uidValidity,
          raw: message.raw ?? null,
          attachments: message.attachments ?? []
        });
        messageCount += 1;
        folderCount += 1;
        batchCount += 1;
        batchHighUid = Math.max(batchHighUid, uidNum);
        lastUid = batchHighUid;
      }
      if (batchCount === 0) {
        if (attemptedRange && attemptedRange.endUid > lastUid) {
          lastUid = attemptedRange.endUid;
          const localMessageCount = store.countMessagesInMailbox?.(accountId, mailbox.id) ?? folderCount;
          await store.checkpoint({
            accountId,
            mailboxId: mailbox.id,
            mode,
            messageCount: folderCount,
            lastUid,
            uidValidity,
            remoteMessages: remote.remoteMessages,
            uidNext: remote.uidNext,
            localMessageCount,
            status: 'syncing',
            startedAt
          });
          continue;
        }
        break;
      }
      if (batchHighUid <= activeCheckpoint.lastUid) break;

      const localMessageCount = store.countMessagesInMailbox?.(accountId, mailbox.id) ?? folderCount;
      await store.checkpoint({
        accountId,
        mailboxId: mailbox.id,
        mode,
        messageCount: folderCount,
        lastUid,
        uidValidity,
        remoteMessages: remote.remoteMessages,
        uidNext: remote.uidNext,
        localMessageCount,
        status: 'syncing',
        startedAt
      });
    }

    const localMessageCount = store.countMessagesInMailbox?.(accountId, mailbox.id) ?? folderCount;
    const complete = isMailboxSyncComplete({
      lastUid,
      uidNext: remote.uidNext,
      remoteMessages: remote.remoteMessages,
      localMessageCount
    });
    await store.checkpoint({
      accountId,
      mailboxId: mailbox.id,
      mode,
      messageCount: folderCount,
      lastUid,
      uidValidity,
      remoteMessages: remote.remoteMessages,
      uidNext: remote.uidNext,
      localMessageCount,
      status: complete ? 'completed' : 'syncing',
      startedAt,
      completedAt: complete ? now() : null
    });
  }

  return { accountId, mode, folders: mailboxes.length, messages: messageCount, skippedMessages, skippedFolders };
}
