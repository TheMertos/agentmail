import { ImapFlow } from 'imapflow';
import { isSelectableMailbox } from './mailbox-sync.mjs';
import { extractIncomingAttachments } from './incoming-mime.mjs';

/** Default deadline for one IMAP lock, status, search, or fetch step. */
export const DEFAULT_IMAP_OPERATION_TIMEOUT_MS = 120_000;

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

/**
 * Raised when an IMAP lock, status, search, or fetch step exceeds its deadline.
 */
export class ImapOperationTimeout extends Error {
  /**
   * @param {string} operation Step that stalled.
   */
  constructor(operation) {
    super(`imap_${operation}_timeout`);
    this.name = 'ImapOperationTimeout';
    this.code = 'ImapOperationTimeout';
    this.operation = operation;
  }
}

export class ImapProvider {
  /**
   * @param {object} options connection, credentials, optional operationTimeoutMs.
   */
  constructor({ connection, credentials, operationTimeoutMs = DEFAULT_IMAP_OPERATION_TIMEOUT_MS }) {
    if (!connection?.host || !connection?.port || !credentials?.username) throw new TypeError('IMAP connection and trusted credentials are required');
    this.connection = connection;
    this.credentials = credentials;
    this.operationTimeoutMs = Number(operationTimeoutMs) > 0 ? Number(operationTimeoutMs) : DEFAULT_IMAP_OPERATION_TIMEOUT_MS;
    this.client = this.#buildClient();
    this.connected = false;
  }

  /**
   * Open a new ImapFlow client. Used for the first connection and after a stall.
   * @returns {ImapFlow} Unconnected client.
   */
  #buildClient() {
    return new ImapFlow({
      host: this.connection.host,
      port: this.connection.port,
      secure: this.connection.security !== 'starttls',
      auth: { user: this.credentials.username, pass: this.credentials.password },
      socketTimeout: this.operationTimeoutMs,
      connectionTimeout: this.operationTimeoutMs,
      greetingTimeout: Math.min(30_000, this.operationTimeoutMs),
      disableAutoIdle: true
    });
  }

  /**
   * Drop the current client so the next call reconnects.
   * A stalled command is closed here; otherwise the worker keeps waiting on it.
   */
  #abandon() {
    const previous = this.client;
    this.connected = false;
    try {
      previous?.close?.();
    } catch {
      // The socket may already be gone.
    }
    this.client = this.#buildClient();
  }

  /**
   * Release a mailbox lock after close without throwing.
   * @param {{ release?: () => void }|undefined} lock Mailbox lock.
   */
  #release(lock) {
    try {
      lock?.release?.();
    } catch {
      // close() already rejected the lock.
    }
  }

  /**
   * Await one IMAP step and abandon the connection when the deadline passes.
   * @param {Promise<unknown>} promise In-flight IMAP call.
   * @param {string} operation Step name used in the timeout error.
   * @returns {Promise<unknown>} The step result.
   */
  async #deadline(promise, operation) {
    let timer;
    const pending = Promise.resolve(promise);
    pending.catch(() => {});
    try {
      return await new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new ImapOperationTimeout(operation)), this.operationTimeoutMs);
        pending.then(
          (value) => resolve(value),
          (error) => reject(error)
        );
      });
    } catch (error) {
      if (error instanceof ImapOperationTimeout || error?.code === 'LockTimeout') {
        this.#abandon();
        if (error instanceof ImapOperationTimeout) throw error;
        throw new ImapOperationTimeout(operation);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Connect, replacing the client after a previous stall.
   * @returns {Promise<ImapProvider>} This provider.
   */
  async connect() {
    if (!this.connected) {
      await this.#deadline(this.client.connect(), 'connect');
      this.connected = true;
    }
    return this;
  }

  /**
   * STATUS one mailbox, retrying once after a timeout reconnects.
   * @param {string} path Mailbox path.
   * @returns {Promise<object|null>} Status fields, or null when the server rejects the mailbox.
   */
  async #mailboxStatus(path) {
    const query = { messages: true, uidNext: true, uidValidity: true };
    try {
      if (!this.connected) await this.connect();
      return await this.#deadline(this.client.status(path, query), 'status');
    } catch (error) {
      if (!(error instanceof ImapOperationTimeout)) throw error;
      await this.connect();
      return await this.#deadline(this.client.status(path, query), 'status');
    }
  }

  /**
   * List mailboxes and lightweight STATUS for selectable folders.
   * A stalled STATUS is retried once, then recorded as unknown so the list can continue.
   * @param {{ includeStatus?: boolean }} [options] Status lookup toggle.
   * @returns {Promise<object[]>} Mailbox records.
   */
  async listMailboxes({ includeStatus = true } = {}) {
    await this.connect();
    const listed = await this.#deadline(this.client.list(), 'list');
    const mailboxes = [];
    for (const mailbox of listed) {
      let messages = null;
      let uidNext = null;
      let uidValidity = null;
      if (includeStatus && isSelectableMailbox({ flags: mailbox.flags ? [...mailbox.flags] : [] })) {
        try {
          const status = await this.#mailboxStatus(mailbox.path);
          messages = status?.messages ?? null;
          uidNext = status?.uidNext ?? null;
          uidValidity = status?.uidValidity != null ? String(status.uidValidity) : null;
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

  /**
   * Append one message.
   * @param {string} mailbox Mailbox path.
   * @param {string} mime MIME source.
   * @param {string[]} [flags] IMAP flags.
   * @returns {Promise<unknown>} Append result.
   */
  async append(mailbox, mime, flags = ['\\Seen']) {
    await this.connect();
    return this.#deadline(this.client.append(mailbox, mime, flags), 'append');
  }

  /**
   * Read one message source by UID.
   * @param {string} mailbox Mailbox path.
   * @param {number|string} uid Message UID.
   * @returns {Promise<string>} MIME source, or an empty string when missing.
   */
  async readByUid(mailbox, uid) {
    await this.connect();
    const lock = await this.#deadline(
      this.client.getMailboxLock(mailbox, { acquireTimeout: this.operationTimeoutMs }),
      'lock'
    );
    try {
      const message = await this.#deadline(
        this.client.fetchOne(String(uid), { source: true }, { uid: true }),
        'fetch'
      );
      return message?.source?.toString('utf8') ?? '';
    } finally {
      this.#release(lock);
    }
  }

  /**
   * Find a Sent mailbox path from the listing.
   * @returns {Promise<string|null>} Path, or null when none matches.
   */
  async findSentMailbox() {
    const mailboxes = await this.listMailboxes();
    return mailboxes.find((mailbox) => /sent|gesendet/i.test(mailbox.path) || /\\\\Sent/i.test(mailbox.specialUse ?? ''))?.path ?? null;
  }

  /**
   * UID SEARCH ALL for one mailbox.
   * @param {object} mailbox Mailbox with path.
   * @returns {Promise<number[]>} Existing UIDs. Empty when the server returns no set.
   */
  async searchUids(mailbox) {
    await this.connect();
    const lock = await this.#deadline(
      this.client.getMailboxLock(mailbox.path, { acquireTimeout: this.operationTimeoutMs }),
      'lock'
    );
    try {
      const result = await this.#deadline(this.client.search({ all: true }, { uid: true }), 'search');
      if (!Array.isArray(result)) return [];
      return result.map((uid) => Number(uid)).filter((uid) => Number.isInteger(uid) && uid > 0);
    } finally {
      this.#release(lock);
    }
  }

  /**
   * Yield fetched messages for one UID query.
   * @param {string} query UID range or explicit UID list.
   * @param {object} status Mailbox STATUS used for UIDVALIDITY.
   * @param {object} mailbox Mailbox being fetched.
   * @returns {AsyncGenerator<object>} Stored message shapes.
   */
  async *#iterateFetch(query, status, mailbox) {
    const iterator = this.client.fetch(query, {
      uid: true,
      flags: true,
      internalDate: true,
      envelope: true,
      // ImapFlow maps source:true to BODY.PEEK[]; never use BODY[] here.
      // Syncing an incoming message must not set the shared server-side \\Seen flag.
      source: true
    }, { uid: true })[Symbol.asyncIterator]();
    try {
      while (true) {
        const next = await this.#deadline(iterator.next(), 'fetch');
        if (next.done) return;
        const message = next.value;
        const raw = message.source?.toString('utf8') ?? null;
        yield {
          uid: message.uid,
          uidValidity: String(status.uidValidity),
          folderId: mailbox.id,
          flags: [...(message.flags ?? [])],
          internalDate: message.internalDate?.toISOString() ?? null,
          envelope: message.envelope ?? null,
          raw,
          attachments: raw ? await extractIncomingAttachments(raw) : []
        };
      }
    } finally {
      const returned = iterator.return?.();
      if (returned && typeof returned.catch === 'function') returned.catch(() => {});
    }
  }

  /**
   * Copy IMAP flags into a plain array.
   * @param {unknown} flags Flags from ImapFlow.
   * @returns {string[]} Flag list. Empty when the server sent none.
   */
  #flagList(flags) {
    if (flags instanceof Set || Array.isArray(flags)) return [...flags];
    return [];
  }

  /**
   * Yield UID and FLAGS for one UID query. The FETCH attributes are only uid and flags.
   * @param {string} query Explicit UID list.
   * @param {object} status Mailbox STATUS used for UIDVALIDITY.
   * @returns {AsyncGenerator<{ uid: number, uidValidity: string, flags: string[] }>} Flag rows.
   */
  async *#iterateFlags(query, status) {
    const iterator = this.client.fetch(query, { uid: true, flags: true }, { uid: true })[Symbol.asyncIterator]();
    try {
      while (true) {
        const next = await this.#deadline(iterator.next(), 'fetch');
        if (next.done) return;
        const message = next.value;
        yield {
          uid: message.uid,
          uidValidity: String(status.uidValidity),
          flags: this.#flagList(message.flags)
        };
      }
    } finally {
      const returned = iterator.return?.();
      if (returned && typeof returned.catch === 'function') returned.catch(() => {});
    }
  }

  /**
   * Fetch UID and FLAGS for explicit UIDs. Does not request source, body, envelope, or bodyStructure and does not STORE.
   * @param {object} mailbox Mailbox with path.
   * @param {{ uids?: number[], uidValidity?: string|number, batchSize?: number }} [options] Expected UIDVALIDITY and batch size.
   * @returns {AsyncGenerator<{ uid: number, uidValidity: string, flags: string[] }>} Flag rows for the requested UIDs.
   */
  async *fetchFlags(mailbox, { uids = [], uidValidity, batchSize = 100 } = {}) {
    const explicit = uids.map((uid) => Number(uid)).filter((uid) => Number.isInteger(uid) && uid > 0);
    if (explicit.length === 0) return;
    if (!mailbox?.path || uidValidity == null || uidValidity === '') throw new Error('identity_mismatch');
    await this.connect();
    const lock = await this.#deadline(
      this.client.getMailboxLock(mailbox.path, { acquireTimeout: this.operationTimeoutMs }),
      'lock'
    );
    try {
      const status = await this.#deadline(
        this.client.status(mailbox.path, { uidValidity: true }),
        'status'
      );
      if (String(status?.uidValidity) !== String(uidValidity)) throw new Error('identity_mismatch');
      const size = Math.max(1, Number(batchSize) || 100);
      for (let index = 0; index < explicit.length; index += size) {
        const query = explicit.slice(index, index + size).join(',');
        yield* this.#iterateFlags(query, status);
      }
    } finally {
      this.#release(lock);
    }
  }

  /**
   * Fetch one bounded UID batch, or an explicit UID list for hole fill.
   * Each lock, STATUS, and message wait is bounded. A stall closes the socket.
   * @param {object} mailbox Mailbox with path and id.
   * @param {object} [options] batchSize, checkpoint, onBatchRange, uids.
   * @returns {AsyncGenerator<object>} Messages in this batch.
   */
  async *fetchMessages(mailbox, { batchSize = 100, checkpoint, onBatchRange, uids } = {}) {
    await this.connect();
    const lock = await this.#deadline(
      this.client.getMailboxLock(mailbox.path, { acquireTimeout: this.operationTimeoutMs }),
      'lock'
    );
    try {
      const status = await this.#deadline(
        this.client.status(mailbox.path, { messages: true, uidValidity: true, uidNext: true }),
        'status'
      );
      const explicit = Array.isArray(uids) ? uids.map((uid) => Number(uid)).filter((uid) => uid > 0) : null;
      if (!explicit && !status?.messages) return;
      let query;
      if (explicit) {
        if (explicit.length === 0) return;
        onBatchRange?.({ startUid: explicit[0], endUid: explicit[explicit.length - 1] });
        query = explicit.join(',');
      } else {
        const startUid = checkpoint?.uidValidity === String(status.uidValidity)
          ? Math.max(1, Number(checkpoint.lastUid ?? 0) + 1)
          : 1;
        const range = boundedUidRange(startUid, batchSize, status.uidNext ?? null);
        if (!range) return;
        onBatchRange?.(range);
        query = `${range.startUid}:${range.endUid}`;
      }
      yield* this.#iterateFetch(query, status, mailbox);
    } finally {
      this.#release(lock);
    }
  }

  /**
   * Write \\Seen for one UID. This is the only provider method that issues UID STORE +FLAGS \\Seen.
   * @param {string} mailbox Selected mailbox path.
   * @param {number|string} uid Message UID.
   * @param {string|number} uidValidity Expected UIDVALIDITY. STORE is not sent when it differs.
   * @returns {Promise<true>} True when the server accepted the flag.
   */
  async markRead(mailbox, uid, uidValidity) {
    return this.#storeSeen(mailbox, uid, uidValidity, 'add');
  }

  /**
   * Clear \\Seen for one UID. This is the only provider method that issues UID STORE -FLAGS \\Seen.
   * @param {string} mailbox Selected mailbox path.
   * @param {number|string} uid Message UID.
   * @param {string|number} uidValidity Expected UIDVALIDITY. STORE is not sent when it differs.
   * @returns {Promise<true>} True when the server accepted the flag.
   */
  async markUnread(mailbox, uid, uidValidity) {
    return this.#storeSeen(mailbox, uid, uidValidity, 'remove');
  }

  /**
   * STORE \\Seen for one UID after the mailbox UIDVALIDITY matches.
   * @param {string} mailbox Selected mailbox path.
   * @param {number|string} uid Message UID.
   * @param {string|number} uidValidity Expected UIDVALIDITY.
   * @param {'add'|'remove'} direction Add or remove \\Seen.
   * @returns {Promise<true>} True when the server accepted the flag.
   */
  async #storeSeen(mailbox, uid, uidValidity, direction) {
    const numericUid = Number(uid);
    if (!mailbox || !Number.isInteger(numericUid) || numericUid <= 0 || uidValidity == null || uidValidity === '') {
      throw new Error('identity_mismatch');
    }
    await this.connect();
    const lock = await this.#deadline(
      this.client.getMailboxLock(mailbox, { acquireTimeout: this.operationTimeoutMs }),
      'lock'
    );
    try {
      const status = await this.#deadline(
        this.client.status(mailbox, { uidValidity: true }),
        'status'
      );
      if (String(status?.uidValidity) !== String(uidValidity)) throw new Error('identity_mismatch');
      const writer = direction === 'remove' ? this.client.messageFlagsRemove : this.client.messageFlagsAdd;
      const stored = await this.#deadline(
        writer.call(this.client, String(numericUid), ['\\Seen'], { uid: true }),
        'store'
      );
      if (!stored) throw new Error(direction === 'remove' ? 'mark_unread_failed' : 'mark_read_failed');
      return true;
    } finally {
      this.#release(lock);
    }
  }

  /**
   * Search one mailbox on the live server and return summaries. Does not STORE and does not persist MIME.
   * After SEARCH, FETCH loads only the UID window for the requested limit and sort order.
   * FETCH uses ENVELOPE, FLAGS, and BODYSTRUCTURE, which do not set \\Seen.
   * @param {{ path: string, id?: string }} mailbox Mailbox to search.
   * @param {object} criteria Normalized search criteria.
   * @returns {Promise<object[]>} Matching summaries for this mailbox.
   */
  async searchSummaries(mailbox, criteria) {
    if (!mailbox?.path) throw new Error('invalid_mailbox');
    await this.connect();
    const lock = await this.#deadline(
      this.client.getMailboxLock(mailbox.path, { acquireTimeout: this.operationTimeoutMs }),
      'lock'
    );
    try {
      const status = await this.#deadline(
        this.client.status(mailbox.path, { uidValidity: true }),
        'status'
      );
      if (status?.uidValidity == null || status.uidValidity === '') throw new Error('identity_mismatch');
      const found = await this.#deadline(
        this.client.search(imapSearchQuery(criteria), { uid: true }),
        'search'
      );
      const uids = selectSearchUids(found, criteria);
      if (uids.length === 0) return [];
      const hits = [];
      const size = 100;
      for (let index = 0; index < uids.length; index += size) {
        const query = uids.slice(index, index + size).join(',');
        const iterator = this.client.fetch(query, {
          uid: true,
          flags: true,
          internalDate: true,
          envelope: true,
          bodyStructure: true
        }, { uid: true })[Symbol.asyncIterator]();
        try {
          while (true) {
            const next = await this.#deadline(iterator.next(), 'fetch');
            if (next.done) break;
            const message = next.value;
            const flags = this.#flagList(message.flags);
            const uid = Number(message.uid);
            hits.push({
              key: `${mailbox.id ?? mailbox.path}:${String(status.uidValidity)}:${uid}`,
              mailboxId: mailbox.path,
              uid,
              uidValidity: String(status.uidValidity),
              internalDate: message.internalDate?.toISOString?.() ?? null,
              flags,
              envelope: message.envelope ?? null,
              hasAttachment: structureHasAttachment(message.bodyStructure)
            });
          }
        } finally {
          const returned = iterator.return?.();
          if (returned && typeof returned.catch === 'function') returned.catch(() => {});
        }
      }
      return hits;
    } finally {
      this.#release(lock);
    }
  }

  /**
   * Fetch one message by UID after UIDVALIDITY matches. BODY.PEEK via source does not set \\Seen.
   * @param {{ mailboxId: string, uid: number, uidValidity: string|number }} identity Exact message identity.
   * @returns {Promise<object|null>} Message summary, or null when the UID is gone.
   */
  async fetchMessage({ mailboxId, uid, uidValidity }) {
    const numericUid = Number(uid);
    if (!mailboxId || !Number.isInteger(numericUid) || numericUid <= 0 || uidValidity == null || uidValidity === '') {
      throw new Error('identity_mismatch');
    }
    await this.connect();
    const lock = await this.#deadline(
      this.client.getMailboxLock(mailboxId, { acquireTimeout: this.operationTimeoutMs }),
      'lock'
    );
    try {
      const status = await this.#deadline(
        this.client.status(mailboxId, { uidValidity: true }),
        'status'
      );
      if (String(status?.uidValidity) !== String(uidValidity)) throw new Error('identity_mismatch');
      const message = await this.#deadline(
        this.client.fetchOne(String(numericUid), {
          uid: true,
          flags: true,
          internalDate: true,
          envelope: true,
          source: true
        }, { uid: true }),
        'fetch'
      );
      if (!message?.uid) return null;
      const raw = message.source?.toString('utf8') ?? '';
      return {
        mailboxId,
        uid: Number(message.uid),
        uidValidity: String(uidValidity),
        flags: this.#flagList(message.flags),
        internalDate: message.internalDate?.toISOString?.() ?? null,
        envelope: message.envelope ?? null,
        raw,
        attachments: raw ? await extractIncomingAttachments(raw) : []
      };
    } finally {
      this.#release(lock);
    }
  }

  /**
   * Close the current connection when it is open.
   * @returns {Promise<void>}
   */
  async close() {
    const client = this.client;
    const wasConnected = this.connected;
    this.connected = false;
    if (!wasConnected || !client) return;
    let timer;
    const logout = Promise.resolve()
      .then(() => client.logout())
      .catch(() => client.close?.());
    logout.catch(() => {});
    try {
      await Promise.race([
        logout,
        new Promise((resolve) => {
          timer = setTimeout(() => {
            try {
              client.close?.();
            } catch {
              // The socket may already be gone.
            }
            resolve();
          }, this.operationTimeoutMs);
        })
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Page size used when a live search omits a limit. Matches message search. */
const SEARCH_UID_LIMIT_DEFAULT = 50;

/** Upper bound for one live search FETCH window. Matches message search. */
const SEARCH_UID_LIMIT_MAX = 200;

/**
 * Keep the UID window requested by sort order so FETCH does not load every SEARCH hit.
 * Descending order keeps the newest (highest) UIDs. Ascending order keeps the oldest (lowest) UIDs.
 * @param {unknown} found UIDs returned by IMAP SEARCH.
 * @param {object} criteria Normalized search criteria. Uses limit and sortOrder.
 * @returns {number[]} UIDs to FETCH, at most the requested limit.
 */
function selectSearchUids(found, criteria) {
  const uids = Array.isArray(found)
    ? found.map((uid) => Number(uid)).filter((uid) => Number.isInteger(uid) && uid > 0)
    : [];
  if (uids.length === 0) return [];
  const limit = searchUidLimit(criteria?.limit);
  const ordered = [...uids].sort((left, right) => left - right);
  if (criteria?.sortOrder === 'asc') return ordered.slice(0, limit);
  return ordered.slice(-limit);
}

/**
 * Clamp the requested page size used to bound a search FETCH.
 * @param {unknown} limit Requested limit.
 * @returns {number} Positive limit from 1 through 200, or the default of 50.
 */
function searchUidLimit(limit) {
  if (!Number.isInteger(limit) || limit < 1) return SEARCH_UID_LIMIT_DEFAULT;
  return Math.min(limit, SEARCH_UID_LIMIT_MAX);
}

/**
 * Build an ImapFlow SEARCH query. An empty filter searches all messages.
 * @param {object} criteria Normalized criteria.
 * @returns {object} ImapFlow search query.
 */
function imapSearchQuery(criteria) {
  const query = {};
  if (criteria?.subject) query.subject = criteria.subject;
  if (criteria?.from) query.from = criteria.from;
  if (criteria?.to) query.to = criteria.to;
  if (criteria?.cc) query.cc = criteria.cc;
  if (criteria?.query) query.text = criteria.query;
  if (criteria?.since) query.since = new Date(criteria.since);
  if (criteria?.before) query.before = new Date(criteria.before);
  if (criteria?.isRead === true || criteria?.isUnread === false) query.seen = true;
  if (criteria?.isUnread === true || criteria?.isRead === false) query.unseen = true;
  if (Object.keys(query).length === 0) query.all = true;
  return query;
}

/**
 * True when a BODYSTRUCTURE node or a child is an attachment.
 * @param {object|null|undefined} node BODYSTRUCTURE node.
 * @returns {boolean}
 */
function structureHasAttachment(node) {
  if (!node || typeof node !== 'object') return false;
  if (String(node.disposition ?? '').toLowerCase() === 'attachment') return true;
  const children = node.childNodes ?? node.children ?? [];
  return Array.isArray(children) && children.some((child) => structureHasAttachment(child));
}
