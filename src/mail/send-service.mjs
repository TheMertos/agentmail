function normalizeMime(mime) {
  return String(mime).replace(/\r?\n/g, '\r\n');
}

export async function sendAndSaveSent({ accountId, mime, smtp, imap }) {
  if (!accountId || !mime || !smtp?.send || !imap?.findSentMailbox || !imap?.append || !imap?.readByUid) {
    throw new TypeError('accountId, MIME, SMTP and IMAP Sent operations are required');
  }
  const reviewedMime = normalizeMime(mime);
  const smtpResult = await smtp.send(reviewedMime);
  if (!smtpResult?.accepted?.length) throw new Error('smtp_not_accepted');

  let mailbox;
  let appended;
  try {
    mailbox = await imap.findSentMailbox();
    appended = await imap.append(mailbox, reviewedMime, ['\\Seen']);
  } catch {
    throw new Error('sent_copy_failed');
  }

  const storedMime = normalizeMime(await imap.readByUid(mailbox, appended.uid));
  if (storedMime !== reviewedMime) throw new Error('sent_copy_verification_failed');
  return { status: 'sent_and_saved', accountId, mailbox, uid: appended.uid, accepted: smtpResult.accepted };
}
