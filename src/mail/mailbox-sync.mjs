/**
 * Whether an IMAP mailbox can be SELECTed and synced.
 * @param {object} mailbox Mailbox listing entry.
 * @returns {boolean} False when \\Noselect is present.
 */
export function isSelectableMailbox(mailbox) {
  const flags = mailbox?.flags;
  if (!flags) return true;
  const list = flags instanceof Set ? [...flags] : Array.isArray(flags) ? flags : [];
  return !list.some((flag) => String(flag).toLowerCase() === '\\noselect');
}

/**
 * Whether UID-based sync has caught up to the server mailbox.
 * @param {object} input lastUid, uidNext, optional remote/local counts.
 * @returns {boolean} True only when a reliable completion condition holds.
 */
export function isMailboxSyncComplete({ lastUid, uidNext, remoteMessages, localMessageCount }) {
  const last = Number(lastUid ?? 0);
  const hasReliableUidNext = uidNext != null && !Number.isNaN(Number(uidNext));
  const hasReliableCounts = remoteMessages != null && localMessageCount != null;

  if (hasReliableCounts && Number(localMessageCount) < Number(remoteMessages)) {
    return false;
  }

  const uidComplete = hasReliableUidNext ? last >= Number(uidNext) - 1 : null;
  const countComplete = hasReliableCounts
    ? Number(localMessageCount) >= Number(remoteMessages)
    : null;

  if (uidComplete !== null && countComplete !== null) {
    return uidComplete && countComplete;
  }
  if (uidComplete !== null) return uidComplete;
  if (countComplete !== null) return countComplete;
  return false;
}
