export async function syncAccount({ accountId, provider, store, mode = 'incremental' }) {
  if (!accountId || !provider || !store) throw new TypeError('accountId, provider and store are required');
  const mailboxes = await provider.listMailboxes({ mode });
  let messageCount = 0;
  let skippedMessages = 0;
  for (const mailbox of mailboxes) {
    const checkpoint = mode === 'incremental' ? await store.getCheckpoint?.(accountId, mailbox.id) : null;
    await store.upsertFolder({ ...mailbox, accountId });
    let folderCount = 0;
    let lastUid = checkpoint?.lastUid ?? 0;
    for await (const message of provider.fetchMessages(mailbox, { mode, checkpoint })) {
      if (message.uid === undefined || message.uid === null) {
        skippedMessages += 1;
        continue;
      }
      const key = `${accountId}:${mailbox.id}:${message.uidValidity}:${message.uid}`;
      await store.upsertMessage({
        ...message,
        accountId,
        mailboxId: mailbox.id,
        key,
        raw: message.raw ?? null,
        attachments: message.attachments ?? []
      });
      messageCount += 1;
      folderCount += 1;
      lastUid = Math.max(lastUid, Number(message.uid) || 0);
    }
    await store.checkpoint({ accountId, mailboxId: mailbox.id, mode, messageCount: folderCount, lastUid });
  }
  return { accountId, mode, folders: mailboxes.length, messages: messageCount, skippedMessages };
}
