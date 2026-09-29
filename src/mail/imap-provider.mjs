import { ImapFlow } from 'imapflow';

export class ImapProvider {
  constructor({ connection, credentials }) {
    if (!connection?.host || !connection?.port || !credentials?.username) throw new TypeError('IMAP connection and trusted credentials are required');
    this.client = new ImapFlow({
      host: connection.host,
      port: connection.port,
      secure: connection.security !== 'starttls',
      auth: { user: credentials.username, pass: credentials.password }
    });
    this.connected = false;
  }

  async connect() {
    if (!this.connected) {
      await this.client.connect();
      this.connected = true;
    }
    return this;
  }

  async listMailboxes() {
    await this.connect();
    return (await this.client.list()).map((mailbox) => ({
      id: mailbox.path,
      path: mailbox.path,
      name: mailbox.name,
      parent: mailbox.parent,
      specialUse: mailbox.specialUse ?? null,
      flags: mailbox.flags ? [...mailbox.flags] : []
    }));
  }

  async append(mailbox, mime, flags = ['\\Seen']) {
    await this.connect();
    return this.client.append(mailbox, mime, flags);
  }

  async readByUid(mailbox, uid) {
    await this.connect();
    const lock = await this.client.getMailboxLock(mailbox);
    try {
      const message = await this.client.fetchOne(String(uid), { source: true }, { uid: true });
      return message?.source?.toString('utf8') ?? '';
    } finally {
      lock.release();
    }
  }

  async findSentMailbox() {
    const mailboxes = await this.listMailboxes();
    return mailboxes.find((mailbox) => /sent|gesendet/i.test(mailbox.path) || /\\\\Sent/i.test(mailbox.specialUse ?? ''))?.path ?? null;
  }

  async *fetchMessages(mailbox, { batchSize = 100, checkpoint } = {}) {
    await this.connect();
    const lock = await this.client.getMailboxLock(mailbox.path);
    try {
      const status = await this.client.status(mailbox.path, { messages: true, uidValidity: true, uidNext: true });
      if (!status.messages) return;
      const startUid = checkpoint?.uidValidity === String(status.uidValidity) ? Math.max(1, Number(checkpoint.lastUid ?? 0) + 1) : 1;
      if (status.uidNext && startUid >= status.uidNext) return;
      for await (const message of this.client.fetch(`${startUid}:*`, { uid: true, flags: true, internalDate: true, envelope: true, source: true }, { uid: true, maxMessages: batchSize })) {
        yield {
          uid: message.uid,
          uidValidity: String(status.uidValidity),
          folderId: mailbox.id,
          flags: [...(message.flags ?? [])],
          internalDate: message.internalDate?.toISOString() ?? null,
          envelope: message.envelope ?? null,
          raw: message.source?.toString('utf8') ?? null,
          attachments: []
        };
      }
    } finally {
      lock.release();
    }
  }

  async close() {
    if (this.connected) {
      this.connected = false;
      await this.client.logout().catch(() => this.client.close());
    }
  }
}
