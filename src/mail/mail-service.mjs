import { ImapOperationTimeout } from './imap-provider.mjs';
import { normalizeMessageSearch, pageMessageHits } from './message-search.mjs';
import { sendAndSaveSent } from './send-service.mjs';

/** Folder searched when message_search omits mailboxId and mailboxIds. */
const DEFAULT_REMOTE_MAILBOX = 'INBOX';

/** How long a provider close may block lease release. */
const PROVIDER_CLOSE_TIMEOUT_MS = 1000;

const SENSITIVE = /password|token|secret|private.?key|credential/i;

function assertLeaseSafe(lease) {
  if (!lease || typeof lease !== 'object' || !lease.leaseId) throw new Error('credential_lease_required');
  for (const key of Object.keys(lease)) {
    if (SENSITIVE.test(key)) throw new Error('plaintext credential in lease');
  }
}

export class MailService {
  constructor({ accountRegistry, leaseBroker, providerFactory }) {
    this.accountRegistry = accountRegistry;
    this.leaseBroker = leaseBroker;
    this.providerFactory = providerFactory;
  }

  async syncAccount() {
    const error = new Error('remote_only_sync_disabled');
    error.code = 'remote_only_sync_disabled';
    throw error;
  }

  /**
   * Open a dedicated Inbox IDLE session.
   * The returned client is not the sync connection. release() closes it and drops the lease.
   * @param {string} accountId Account id.
   * @returns {Promise<{ client: object, release: () => Promise<void> }>} Idle session.
   */
  async openIdleWatch() {
    const error = new Error('remote_only_idle_disabled');
    error.code = 'remote_only_idle_disabled';
    throw error;
  }

  async listMailboxes(accountId) {
    const account = this.accountRegistry?.get(accountId);
    if (!account) throw new Error('account_not_found');
    if (!this.leaseBroker?.acquire) throw new Error('credential_lease_unavailable');
    if (!this.providerFactory) throw new Error('provider_unavailable');

    const lease = await this.leaseBroker.acquire({ accountId, purpose: 'imap-list-mailboxes', fields: ['imap'] });
    assertLeaseSafe(lease);
    const provider = await this.providerFactory({ account, lease, operation: 'imap-list-mailboxes' });
    try {
      return await provider.listMailboxes();
    } finally {
      await provider.close?.();
      await this.leaseBroker.release?.(lease);
    }
  }

  /**
   * Search the live IMAP server. Provider errors propagate and are never filled from a local mirror.
   * @param {object} criteria Search criteria.
   * @returns {Promise<object>} Search page.
   */
  async searchRemote(criteria) {
    const normalized = normalizeMessageSearch(criteria);
    const account = this.accountFor(normalized.accountId);
    return this.withImap(account, 'imap-search', async (provider) => {
      try {
        if (typeof provider.searchSummaries !== 'function') throw new Error('provider_unavailable');
        const hits = [];
        for (const mailbox of remoteSearchTargets(normalized.mailboxIds)) {
          const rows = await provider.searchSummaries(mailbox, normalized);
          for (const row of rows) {
            if (!flagsMatch(row.flags, normalized)) continue;
            if (normalized.hasAttachment === true && !row.hasAttachment) continue;
            if (normalized.hasAttachment === false && row.hasAttachment) continue;
            const mailboxId = row.mailboxId || mailbox.path;
            hits.push({
              ...row,
              accountId: normalized.accountId,
              mailboxId,
              key: `${normalized.accountId}:${mailboxId}:${row.uidValidity}:${row.uid}`
            });
          }
        }
        return pageMessageHits(hits, normalized);
      } catch (error) {
        if (isRemoteImapTimeout(error)) throw remoteTimeoutError();
        throw error;
      }
    });
  }

  /**
   * Fetch one message from IMAP without setting \\Seen and without writing it locally.
   * @param {string} messageKey Exact account, mailbox, UIDVALIDITY, and UID key.
   * @returns {Promise<object|null>} Message, or null when the UID is gone.
   */
  async peekMessage(messageKey) {
    const identity = parseMessageKey(messageKey);
    const account = this.accountFor(identity.accountId);
    return this.withImap(account, 'imap-read', async (provider) => {
      const fetched = await requireFetch(provider, identity);
      return fetched ? shapeMessage(identity, fetched, fetched.flags) : null;
    });
  }

  /**
   * Fetch one message and set \\Seen on the provider. Fails closed when STORE fails. Does not write MIME or flags locally.
   * @param {string} messageKey Exact message key.
   * @returns {Promise<object>} Fetched message including \\Seen.
   */
  async readAndMarkSeen(messageKey) {
    const identity = parseMessageKey(messageKey);
    const account = this.accountFor(identity.accountId);
    return this.withImap(account, 'imap-mark-read', async (provider) => {
      const fetched = await requireFetch(provider, identity);
      if (!fetched) throw new Error('source_message_not_found');
      await provider.markRead(identity.mailboxId, identity.uid, identity.uidValidity);
      return shapeMessage(identity, fetched, flagsWithSeen(fetched.flags));
    });
  }

  /**
   * Set provider \\Seen for one exact UID and UIDVALIDITY. Does not read or write a local message mirror.
   * @param {string} messageKey Exact message key.
   * @returns {Promise<{ messageKey: string, accountId: string, mailboxId: string, uid: number, uidValidity: string, flags: string[] }>} Marked identity.
   */
  async markRead(messageKey) {
    return changeSeenFlag(this, messageKey, {
      operation: 'imap-mark-read',
      write: (provider, identity) => provider.markRead(identity.mailboxId, identity.uid, identity.uidValidity),
      flagsFor: flagsWithSeen
    });
  }

  /**
   * Clear provider \\Seen for one exact UID and UIDVALIDITY. Does not write local flags.
   * @param {string} messageKey Exact message key.
   * @returns {Promise<{ messageKey: string, accountId: string, mailboxId: string, uid: number, uidValidity: string, flags: string[] }>} Unmarked identity.
   */
  async markUnread(messageKey) {
    return changeSeenFlag(this, messageKey, {
      operation: 'imap-mark-unread',
      write: (provider, identity) => provider.markUnread(identity.mailboxId, identity.uid, identity.uidValidity),
      flagsFor: flagsWithoutSeen
    });
  }

  /**
   * Resolve an accessible account or throw.
   * @param {string} accountId Account id.
   * @returns {object} Account record.
   */
  accountFor(accountId) {
    const account = typeof this.accountRegistry?.assertAccountAccess === 'function'
      ? this.accountRegistry.assertAccountAccess(accountId)
      : this.accountRegistry?.get?.(accountId);
    if (!account) throw new Error('account_not_found');
    return account;
  }

  /**
   * Open an IMAP provider for one operation and always release the lease.
   * @param {object} account Account record.
   * @param {string} operation Provider operation name.
   * @param {(provider: object) => Promise<unknown>} fn Remote work.
   * @returns {Promise<unknown>} fn result.
   */
  async withImap(account, operation, fn) {
    if (!this.leaseBroker?.acquire) throw new Error('credential_lease_unavailable');
    if (!this.providerFactory) throw new Error('provider_unavailable');
    const lease = await this.leaseBroker.acquire({ accountId: account.id, purpose: 'imap-sync', fields: ['imap'] });
    assertLeaseSafe(lease);
    let provider;
    try {
      provider = await this.providerFactory({ account, lease, operation });
      return await fn(provider);
    } finally {
      await releaseProvider(provider);
      await this.leaseBroker.release?.(lease);
    }
  }

  async sendMime(accountId, mime) {
    const account = this.accountRegistry?.get(accountId);
    if (!account) throw new Error('account_not_found');
    if (!this.leaseBroker?.acquire) throw new Error('credential_lease_unavailable');
    if (!this.providerFactory) throw new Error('provider_unavailable');

    const smtpLease = await this.leaseBroker.acquire({ accountId, purpose: 'smtp-send', fields: ['smtp'] });
    assertLeaseSafe(smtpLease);
    const smtp = await this.providerFactory({ account, lease: smtpLease, operation: 'smtp-send' });

    const imapLease = await this.leaseBroker.acquire({ accountId, purpose: 'imap-sync', fields: ['imap'] });
    assertLeaseSafe(imapLease);
    const imap = await this.providerFactory({ account, lease: imapLease, operation: 'imap-sync' });

    try {
      return await sendAndSaveSent({ accountId, mime, smtp, imap });
    } finally {
      await smtp.close?.();
      await imap.close?.();
      await this.leaseBroker.release?.(smtpLease);
      await this.leaseBroker.release?.(imapLease);
    }
  }
}

/**
 * Resolve one exact UID and write or clear provider \\Seen. Local flags and MIME are not written.
 * @param {MailService} service Mail service with registry, lease broker, and provider factory.
 * @param {string} messageKey Exact message key.
 * @param {{ operation: string, write: Function, flagsFor: (flags: unknown) => string[] }} change Provider write and response flag projection.
 * @returns {Promise<{ messageKey: string, accountId: string, mailboxId: string, uid: number, uidValidity: string, flags: string[] }>} Updated identity.
 */
async function changeSeenFlag(service, messageKey, { operation, write, flagsFor }) {
  const identity = parseMessageKey(messageKey);
  const account = service.accountFor(identity.accountId);
  return service.withImap(account, operation, async (provider) => {
    const fetched = await requireFetch(provider, identity);
    if (!fetched) throw new Error('source_message_not_found');
    assertFetchedIdentity(identity, fetched);
    await write(provider, identity);
    return {
      messageKey,
      accountId: identity.accountId,
      mailboxId: identity.mailboxId,
      uid: identity.uid,
      uidValidity: String(identity.uidValidity),
      flags: flagsFor(fetched.flags)
    };
  });
}

/**
 * Parse account, mailbox path, UIDVALIDITY, and UID from a message key.
 * The mailbox path is the IMAP path and may contain colons.
 * @param {string} messageKey Message key.
 * @returns {{ accountId: string, mailboxId: string, uidValidity: string, uid: number, messageKey: string }}
 */
export function parseMessageKey(messageKey) {
  if (typeof messageKey !== 'string' || messageKey.trim() === '' || messageKey !== messageKey.trim()) {
    throw new Error('message_key_required');
  }
  const parts = messageKey.split(':');
  if (parts.length < 4) throw new Error('identity_mismatch');
  const uid = Number(parts.at(-1));
  const uidValidity = parts.at(-2);
  const accountId = parts[0];
  const mailboxId = parts.slice(1, -2).join(':');
  if (!accountId || !mailboxId || uidValidity === '' || !Number.isInteger(uid) || uid <= 0) {
    throw new Error('identity_mismatch');
  }
  return { accountId, mailboxId, uidValidity, uid, messageKey };
}

/**
 * Fetch one message and reject a provider that cannot fetch.
 * @param {object} provider IMAP provider.
 * @param {object} identity Parsed message identity.
 * @returns {Promise<object|null>} Fetched message or null.
 */
async function requireFetch(provider, identity) {
  if (typeof provider.fetchMessage !== 'function') throw new Error('provider_unavailable');
  return provider.fetchMessage(identity);
}

/**
 * Reject a fetch whose UID or UIDVALIDITY is not the requested identity.
 * @param {object} identity Requested identity.
 * @param {object} fetched Provider message.
 */
function assertFetchedIdentity(identity, fetched) {
  if (Number(fetched.uid) !== identity.uid || String(fetched.uidValidity) !== String(identity.uidValidity)) {
    throw new Error('identity_mismatch');
  }
}

/**
 * Shape a provider fetch as a message result. Does not persist it.
 * @param {object} identity Parsed key.
 * @param {object} fetched Provider message.
 * @param {string[]} flags Flags to report.
 * @returns {object} Message result.
 */
function shapeMessage(identity, fetched, flags) {
  return {
    key: identity.messageKey,
    accountId: identity.accountId,
    mailboxId: identity.mailboxId,
    uid: identity.uid,
    uidValidity: String(identity.uidValidity),
    internalDate: fetched.internalDate ?? null,
    raw: fetched.raw ?? '',
    flags,
    envelope: fetched.envelope ?? null,
    attachments: fetched.attachments ?? []
  };
}

/**
 * Folders for one live search. An omitted list is INBOX only and never discovers other folders.
 * @param {string[]} mailboxIds Normalized mailbox ids or paths.
 * @returns {{ id: string, path: string }[]} Search targets.
 */
function remoteSearchTargets(mailboxIds) {
  const ids = mailboxIds?.length ? mailboxIds : [DEFAULT_REMOTE_MAILBOX];
  return ids.map((id) => ({ id, path: id }));
}

/**
 * True when an IMAP step exceeded its deadline.
 * @param {unknown} error Caught provider error.
 * @returns {boolean}
 */
function isRemoteImapTimeout(error) {
  return error instanceof ImapOperationTimeout
    || error?.code === 'ImapOperationTimeout'
    || error?.code === 'LockTimeout';
}

/**
 * Stable timeout error for interactive IMAP search.
 * @returns {Error} Error with code remote_timeout.
 */
function remoteTimeoutError() {
  const error = new Error('remote_timeout');
  error.code = 'remote_timeout';
  return error;
}

/**
 * Close a provider without letting a stuck logout hold the credential lease.
 * @param {{ close?: () => Promise<void>|void }|undefined} provider IMAP or SMTP provider.
 * @returns {Promise<void>}
 */
async function releaseProvider(provider) {
  if (typeof provider?.close !== 'function') return;
  let timer;
  const closing = Promise.resolve(provider.close()).catch(() => {});
  await new Promise((resolve) => {
    timer = setTimeout(resolve, PROVIDER_CLOSE_TIMEOUT_MS);
    closing.then(resolve, resolve);
  });
  clearTimeout(timer);
}

/**
 * True when live flags satisfy includeFlags and read-state filters already applied by IMAP.
 * @param {string[]} flags Live flags.
 * @param {object} normalized Search criteria.
 * @returns {boolean}
 */
function flagsMatch(flags, normalized) {
  const list = Array.isArray(flags) ? flags.map((flag) => String(flag).toLowerCase()) : [];
  return normalized.flags.every((flag) => list.includes(String(flag).toLowerCase()));
}

/**
 * Return a copy of flags that includes \\Seen.
 * @param {unknown} flags Stored flags.
 * @returns {string[]} Flags after the explicit mark.
 */
function flagsWithSeen(flags) {
  const list = Array.isArray(flags) ? [...flags] : [];
  if (list.some((flag) => String(flag).toLowerCase() === '\\seen')) return list;
  list.push('\\Seen');
  return list;
}

/**
 * Return a copy of flags without \\Seen.
 * @param {unknown} flags Stored flags.
 * @returns {string[]} Flags after the explicit unread mark.
 */
function flagsWithoutSeen(flags) {
  const list = Array.isArray(flags) ? flags : [];
  return list.filter((flag) => String(flag).toLowerCase() !== '\\seen');
}

export { assertLeaseSafe };
