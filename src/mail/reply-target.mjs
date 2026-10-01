function withReplyPrefix(subject) {
  return /^re:/i.test(subject) ? subject : `Re: ${subject}`;
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
