import { redactToolError } from '../security/redact.mjs';

function normalizeMime(mime) {
  return String(mime).replace(/\r?\n/g, '\r\n');
}

export async function sendAndSaveSent({ accountId, mime, smtp, imap, logger = console }) {
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
  } catch (error) {
    logger?.warn?.({ event: 'sent_copy_failed', accountId, error: redactToolError(error) });
    throw new Error('sent_copy_failed');
  }

  let storedMime;
  try {
    storedMime = normalizeMime(await imap.readByUid(mailbox, appended.uid));
  } catch (error) {
    logger?.warn?.({
      event: 'sent_copy_unverified',
      accountId,
      mailbox,
      uid: appended.uid,
      error: redactToolError(error)
    });
    throw new Error('sent_copy_unverified');
  }
  if (storedMime !== reviewedMime) {
    logger?.warn?.({
      event: 'sent_copy_verification_failed',
      accountId,
      mailbox,
      uid: appended.uid
    });
    throw new Error('sent_copy_verification_failed');
  }
  return { status: 'sent_and_saved', accountId, mailbox, uid: appended.uid, accepted: smtpResult.accepted };
}
