import { ImapFlow } from 'imapflow';

/**
 * Compute inclusive UID range for one bounded fetch batch.
 * @param {number} startUid First UID to fetch.
 * @param {number} batchSize Maximum UIDs in the batch.
 * @param {number|null} uidNext Mailbox uidNext from STATUS.
 * @returns {{ startUid: number, endUid: number }|null} Range or null when nothing remains.
 */
export function boundedUidRange(startUid, batchSize, uidNext) {
  if (uidNext == null || startUid >= uidNext) return null;
  const endUid = Math.min(startUid + batchSize - 1, uidNext - 1);
  if (startUid > endUid) return null;
  return { startUid, endUid };
}

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

  async listMailboxes({ includeStatus = true } = {}) {
    await this.connect();
    const listed = await this.client.list();
    const mailboxes = [];
    for (const mailbox of listed) {
      let messages = null;
      let uidNext = null;
      let uidValidity = null;
      if (includeStatus) {
        try {
          const status = await this.client.status(mailbox.path, { messages: true, uidNext: true, uidValidity: true });
          messages = status.messages ?? null;
          uidNext = status.uidNext ?? null;
          uidValidity = status.uidValidity != null ? String(status.uidValidity) : null;
        } catch {
          messages = null;
          uidNext = null;
          uidValidity = null;
        }
      }
      mailboxes.push({
        id: mailbox.path,
        path: mailbox.path,
        name: mailbox.name,
        parent: mailbox.parent,
        specialUse: mailbox.specialUse ?? null,
        flags: mailbox.flags ? [...mailbox.flags] : [],
        messages,
        uidNext,
        uidValidity
      });
    }
    return mailboxes;
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
      const range = boundedUidRange(startUid, batchSize, status.uidNext ?? null);
      if (!range) return;
      for await (const message of this.client.fetch(`${range.startUid}:${range.endUid}`, { uid: true, flags: true, internalDate: true, envelope: true, source: true }, { uid: true })) {
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
