import { boundedUidRange, ImapOperationTimeout } from './imap-provider.mjs';
import { isMailboxSyncComplete, isSelectableMailbox, reconcileMailboxCompletion } from './mailbox-sync.mjs';

/**
 * Whether a thrown error is a bounded IMAP stall.
 * @param {unknown} error Caught value.
 * @returns {boolean} True for ImapOperationTimeout.
 */
function isImapStall(error) {
  return error instanceof ImapOperationTimeout || error?.code === 'ImapOperationTimeout';
}

/**
 * Copy STATUS fields used for checkpoint comparisons.
 * @param {object} mailbox Listed mailbox.
 * @returns {{ uidValidity: string|null, uidNext: number|null, remoteMessages: number|null }} Remote mailbox status.
 */
function mailboxRemoteStatus(mailbox) {
  return {
    uidValidity: mailbox.uidValidity != null ? String(mailbox.uidValidity) : null,
    uidNext: mailbox.uidNext != null ? Number(mailbox.uidNext) : null,
    remoteMessages: mailbox.messages != null ? Number(mailbox.messages) : (mailbox.remoteMessages != null ? Number(mailbox.remoteMessages) : null)
  };
}

/**
 * Whether incremental sync can skip a mailbox that is already caught up.
 * @param {object|null} checkpoint Stored checkpoint.
 * @param {object} remote Current STATUS fields.
 * @param {string} mode Sync mode.
 * @returns {boolean} True when the folder should be skipped.
 */
function isMailboxUpToDate(checkpoint, remote, mode) {
  if (mode !== 'incremental' || !checkpoint) return false;
  if (checkpoint.status !== 'completed') return false;
  if (remote.uidValidity && checkpoint.uidValidity && checkpoint.uidValidity !== remote.uidValidity) return false;
  if (checkpoint.uidNext == null || remote.uidNext == null) return false;
  if (
    remote.remoteMessages != null
    && checkpoint.localMessageCount != null
    && Number(checkpoint.localMessageCount) < Number(remote.remoteMessages)
  ) return false;
  return checkpoint.uidNext === remote.uidNext;
}

/**
 * Inclusive UID span for a batch that produced no messages.
 * @param {{ startUid: number, endUid: number }|null} attemptedRange Range reported by the provider.
 * @param {{ startUid: number, endUid: number }|null} plannedRange Range planned from the checkpoint.
 * @returns {number} Span length, at least 1 when a range exists.
 */
function stalledSpan(attemptedRange, plannedRange) {
  const range = attemptedRange ?? plannedRange;
  if (!range) return 0;
  return Math.max(1, range.endUid - range.startUid + 1);
}

/**
 * Synchronize one account with resumable per-batch checkpoints.
 * A stalled fetch reconnects from the last stored UID. A single UID that times out
 * twice is skipped so the checkpoint still moves. Gmail UID holes are filled from
 * UID SEARCH without fetching messages that are already stored.
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
    let errorClass = null;
    let verifiedUidCount = null;
    const knownUids = new Set((store.listMessageUids?.(accountId, mailbox.id) ?? []).map((uid) => Number(uid)));

    /**
     * Persist the mailbox cursor. localMessageCount is the stored row count.
     * @param {string} status Checkpoint status.
     * @param {object} [extra] remoteMessages, completedAt, errorClass overrides.
     * @returns {Promise<void>}
     */
    async function save(status, extra = {}) {
      const localMessageCount = store.countMessagesInMailbox?.(accountId, mailbox.id) ?? knownUids.size;
      await store.checkpoint?.({
        accountId,
        mailboxId: mailbox.id,
        mode,
        lastUid,
        uidValidity,
        remoteMessages: extra.remoteMessages ?? remote.remoteMessages,
        uidNext: remote.uidNext,
        localMessageCount,
        status,
        startedAt,
        completedAt: extra.completedAt ?? null,
        messageCount: localMessageCount,
        errorClass: extra.errorClass === undefined ? errorClass : extra.errorClass
      });
    }

    /**
     * Store one fetched message and move the cursor when its UID is new.
     * @param {object} message Provider message.
     * @param {{ allowSeen?: boolean }} [options] allowSeen keeps UIDs below the cursor during hole fill.
     * @returns {Promise<boolean>} True when the message was stored.
     */
    async function storeOne(message, { allowSeen = false } = {}) {
      if (message.uid === undefined || message.uid === null) {
        skippedMessages += 1;
        return false;
      }
      const uidNum = Number(message.uid) || 0;
      if (knownUids.has(uidNum) || (!allowSeen && uidNum <= lastUid)) {
        skippedMessages += 1;
        return false;
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
      knownUids.add(uidNum);
      messageCount += 1;
      if (uidNum > lastUid) lastUid = uidNum;
      await save('syncing', { errorClass: null });
      errorClass = null;
      return true;
    }

    await save('syncing', { errorClass: null });

    let batchSizeOverride = null;
    let singleUidStrikes = 0;
    let skippedStalledUid = false;
    while (true) {
      const localMessageCount = store.countMessagesInMailbox?.(accountId, mailbox.id) ?? knownUids.size;
      if (isMailboxSyncComplete({
        lastUid,
        uidNext: remote.uidNext,
        remoteMessages: remote.remoteMessages,
        localMessageCount
      })) {
        break;
      }
      const size = batchSizeOverride ?? batchSize;
      const plannedRange = remote.uidNext != null ? boundedUidRange(lastUid + 1, size, remote.uidNext) : null;
      if (remote.uidNext != null && !plannedRange) break;

      let batchCount = 0;
      let attemptedRange = null;
      const activeCheckpoint = { lastUid, uidValidity };
      try {
        for await (const message of provider.fetchMessages(mailbox, {
          mode,
          checkpoint: activeCheckpoint,
          batchSize: size,
          onBatchRange: (range) => { attemptedRange = range; }
        })) {
          if (await storeOne(message)) {
            batchCount += 1;
            skippedStalledUid = false;
          }
        }
        singleUidStrikes = 0;
        batchSizeOverride = null;
        if (batchCount === 0) {
          if (attemptedRange && attemptedRange.endUid > lastUid) {
            lastUid = attemptedRange.endUid;
            await save('syncing');
            continue;
          }
          break;
        }
      } catch (error) {
        if (!isImapStall(error)) throw error;
        errorClass = 'imap_operation_timeout';
        await save('syncing');
        const span = stalledSpan(attemptedRange, plannedRange);
        if (batchCount > 0 || span === 0) {
          if (span === 0 && batchCount === 0) throw error;
          batchSizeOverride = null;
          singleUidStrikes = 0;
          continue;
        }
        if (span > 1) {
          batchSizeOverride = Math.max(1, Math.floor(span / 2));
          continue;
        }
        singleUidStrikes += 1;
        if (singleUidStrikes < 2) {
          batchSizeOverride = 1;
          continue;
        }
        if (skippedStalledUid) break;
        const skipTo = attemptedRange?.endUid ?? plannedRange?.endUid ?? (lastUid + 1);
        if (!(skipTo > lastUid)) throw error;
        lastUid = skipTo;
        skippedStalledUid = true;
        singleUidStrikes = 0;
        batchSizeOverride = null;
        await save('syncing');
      }
    }

    if (
      typeof provider.searchUids === 'function'
      && remote.uidNext != null
      && lastUid >= Number(remote.uidNext) - 1
      && remote.remoteMessages != null
      && (store.countMessagesInMailbox?.(accountId, mailbox.id) ?? knownUids.size) < Number(remote.remoteMessages)
    ) {
      let remoteUids = null;
      try {
        remoteUids = await provider.searchUids(mailbox);
      } catch (error) {
        if (!isImapStall(error)) throw error;
        errorClass = 'imap_operation_timeout';
        remoteUids = null;
      }
      const trusted = Array.isArray(remoteUids)
        && !(remoteUids.length === 0 && Number(remote.remoteMessages) > 0);
      if (trusted) {
        const missing = remoteUids.map((uid) => Number(uid)).filter((uid) => !knownUids.has(uid));
        let filled = true;
        for (let index = 0; index < missing.length; index += batchSize) {
          const chunk = missing.slice(index, index + batchSize);
          try {
            for await (const message of provider.fetchMessages(mailbox, {
              mode,
              batchSize,
              uids: chunk,
              checkpoint: { lastUid, uidValidity }
            })) {
              await storeOne(message, { allowSeen: true });
            }
          } catch (error) {
            if (!isImapStall(error)) throw error;
            errorClass = 'imap_operation_timeout';
            filled = false;
            break;
          }
        }
        if (filled && missing.every((uid) => knownUids.has(uid))) {
          verifiedUidCount = remoteUids.length;
        }
      }
    }

    const localMessageCount = store.countMessagesInMailbox?.(accountId, mailbox.id) ?? knownUids.size;
    const reconciled = reconcileMailboxCompletion({
      lastUid,
      uidNext: remote.uidNext,
      remoteMessages: remote.remoteMessages,
      localMessageCount,
      verifiedUidCount
    });
    await save(reconciled.complete ? 'completed' : 'syncing', {
      remoteMessages: reconciled.remoteMessages,
      completedAt: reconciled.complete ? now() : null,
      errorClass: reconciled.complete ? null : errorClass
    });
  }

  return { accountId, mode, folders: mailboxes.length, messages: messageCount, skippedMessages, skippedFolders };
}
