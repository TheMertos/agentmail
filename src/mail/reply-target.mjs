/**
 * Strip CR/LF from an untrusted remote Subject header before it is echoed back
 * as a reply suggestion. A malicious sender can craft a Subject containing embedded
 * control characters; without this, the suggestion could carry them into a caller's
 * send_approval_create subject and smuggle extra MIME headers (see encodeSubject's
 * own CRLF rejection in preview-binding.mjs, which this defends in depth).
 * @param {string} subject Raw envelope subject from an untrusted source.
 * @returns {string} Subject with any CR/LF removed.
 */
function sanitizeSubject(subject) {
  return subject.replace(/[\r\n]+/g, ' ');
}

function withReplyPrefix(subject) {
  const clean = sanitizeSubject(subject);
  return /^re:/i.test(clean) ? clean : `Re: ${clean}`;
}

export function resolveReplyTarget({ store, message, accountId, sourceMessageKey, mode = 'reply' }) {
  if (!accountId || !sourceMessageKey) throw new TypeError('accountId and sourceMessageKey are required');
  const resolved = message ?? store?.getMessage?.(sourceMessageKey);
  if (!resolved) throw new Error('source_message_not_found');
  if (resolved.accountId !== accountId) throw new Error('account_mismatch');

  const envelope = resolved.envelope ?? {};
  const messageId = envelope.messageId ?? null;
  const references = [...(envelope.references ?? []), ...(messageId ? [messageId] : [])];

  let to = envelope.from ?? [];
  if (mode === 'reply-all') {
    to = [...(envelope.from ?? []), ...(envelope.to ?? []), ...(envelope.cc ?? [])];
  }

  return {
    sourceMessageKey,
    mode,
    headers: {
      inReplyTo: messageId,
      references,
      subject: withReplyPrefix(envelope.subject ?? '(no subject)'),
      to
    },
    quoteSource: { raw: resolved.raw ?? '', envelope }
  };
}
