function withReplyPrefix(subject) {
  return /^re:/i.test(subject) ? subject : `Re: ${subject}`;
}

export function resolveReplyTarget({ store, accountId, sourceMessageKey, mode = 'reply' }) {
  if (!store || !accountId || !sourceMessageKey) throw new TypeError('store, accountId and sourceMessageKey are required');
  const message = store.getMessage(sourceMessageKey);
  if (!message) throw new Error('source_message_not_found');
  if (message.accountId !== accountId) throw new Error('account_mismatch');

  const envelope = message.envelope ?? {};
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
    quoteSource: { raw: message.raw ?? '', envelope }
  };
}
