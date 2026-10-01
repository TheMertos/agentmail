import { syncAccount } from './sync-engine.mjs';
import { sendAndSaveSent } from './send-service.mjs';

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

  async syncAccount(accountId, { mode = 'incremental', store }) {
    const account = this.accountRegistry?.get(accountId);
    if (!account) throw new Error('account_not_found');
    if (!store) throw new Error('mail_store_unavailable');
    if (!this.leaseBroker?.acquire) throw new Error('credential_lease_unavailable');
    if (!this.providerFactory) throw new Error('provider_unavailable');
    const lease = await this.leaseBroker.acquire({ accountId, purpose: 'imap-sync', fields: ['imap'] });
    assertLeaseSafe(lease);
    const provider = await this.providerFactory({ account, lease, operation: 'imap-sync' });
    try {
      return await syncAccount({ accountId, provider, store, mode });
    } finally {
      await provider.close?.();
      await this.leaseBroker.release?.(lease);
    }
  }

  /**
   * Open a dedicated Inbox IDLE session.
   * The returned client is not the sync connection. release() closes it and drops the lease.
   * @param {string} accountId Account id.
   * @returns {Promise<{ client: object, release: () => Promise<void> }>} Idle session.
   */
  async openIdleWatch(accountId) {
    const account = this.accountRegistry?.get(accountId);
    if (!account) throw new Error('account_not_found');
    if (!this.leaseBroker?.acquire) throw new Error('credential_lease_unavailable');
    if (!this.providerFactory) throw new Error('provider_unavailable');
    const lease = await this.leaseBroker.acquire({ accountId, purpose: 'imap-idle', fields: ['imap'] });
    assertLeaseSafe(lease);
    try {
      const provider = await this.providerFactory({ account, lease, operation: 'imap-idle' });
      let released = false;
      return {
        client: provider,
        /**
         * Close the IDLE provider and release its SecretFabric lease.
         * @returns {Promise<void>}
         */
        release: async () => {
          if (released) return;
          released = true;
          try {
            await provider.close?.();
          } finally {
            await this.leaseBroker.release?.(lease);
          }
        }
      };
    } catch (error) {
      await this.leaseBroker.release?.(lease);
      throw error;
    }
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
   * Set provider \\Seen for one exact mirrored message. Other IMAP reads do not call this.
   * @param {string} messageKey Exact local message key.
   * @param {object} store Mail store used to resolve account, mailbox, and UID.
   * @returns {Promise<{ messageKey: string, accountId: string, mailboxId: string, uid: number, uidValidity: string, flags: string[] }>} Marked identity.
   */
  async markRead(messageKey, store) {
    return changeSeenFlag(this, messageKey, store, {
      purpose: 'imap-sync',
      operation: 'imap-mark-read',
      write: (provider, mailbox, message) => provider.markRead(mailbox, message.uid, message.uidValidity),
      flagsFor: flagsWithSeen
    });
  }

  /**
   * Clear provider \\Seen for one exact mirrored message. Passive sync does not call this.
   * @param {string} messageKey Exact local message key.
   * @param {object} store Mail store used to resolve account, mailbox, and UID.
   * @returns {Promise<{ messageKey: string, accountId: string, mailboxId: string, uid: number, uidValidity: string, flags: string[] }>} Unmarked identity.
   */
  async markUnread(messageKey, store) {
    return changeSeenFlag(this, messageKey, store, {
      purpose: 'imap-sync',
      operation: 'imap-mark-unread',
      write: (provider, mailbox, message) => provider.markUnread(mailbox, message.uid, message.uidValidity),
      flagsFor: flagsWithoutSeen
    });
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
 * Resolve one exact message and write or clear provider \\Seen. Local flags change only after the provider accepts the STORE.
 * @param {MailService} service Mail service with registry, lease broker, and provider factory.
 * @param {string} messageKey Exact local message key.
 * @param {object} store Mail store used to resolve account, mailbox, and UID.
 * @param {{ purpose: string, operation: string, write: Function, flagsFor: (flags: unknown) => string[] }} change Provider write and local flag projection.
 * @returns {Promise<{ messageKey: string, accountId: string, mailboxId: string, uid: number, uidValidity: string, flags: string[] }>} Updated identity.
 */
async function changeSeenFlag(service, messageKey, store, { purpose, operation, write, flagsFor }) {
  if (typeof messageKey !== 'string' || messageKey.trim() === '') throw new Error('message_key_required');
  if (!store?.getMessage) throw new Error('mail_store_unavailable');
  const message = store.getMessage(messageKey);
  if (!message) throw new Error('source_message_not_found');
  if (message.key !== messageKey || canonicalMessageKey(message) !== messageKey) throw new Error('identity_mismatch');
  const account = typeof service.accountRegistry?.assertAccountAccess === 'function'
    ? service.accountRegistry.assertAccountAccess(message.accountId)
    : service.accountRegistry?.get?.(message.accountId);
  if (!account) throw new Error('account_not_found');
  if (!service.leaseBroker?.acquire) throw new Error('credential_lease_unavailable');
  if (!service.providerFactory) throw new Error('provider_unavailable');
  const mailbox = mailboxPathFor(store, message);
  const lease = await service.leaseBroker.acquire({ accountId: message.accountId, purpose, fields: ['imap'] });
  assertLeaseSafe(lease);
  let provider;
  try {
    provider = await service.providerFactory({ account, lease, operation });
    await write(provider, mailbox, message);
    const flags = flagsFor(message.flags);
    await store.upsertMessage({ ...message, flags });
    return {
      messageKey,
      accountId: message.accountId,
      mailboxId: message.mailboxId,
      uid: message.uid,
      uidValidity: String(message.uidValidity),
      flags
    };
  } finally {
    await provider?.close?.();
    await service.leaseBroker.release?.(lease);
  }
}

/**
 * Rebuild the mirror key from stored account, mailbox, UIDVALIDITY, and UID.
 * @param {{ accountId: string, mailboxId: string, uidValidity: string|number, uid: number|string }} message Stored message.
 * @returns {string} Canonical message key.
 */
function canonicalMessageKey(message) {
  return `${message.accountId}:${message.mailboxId}:${message.uidValidity}:${message.uid}`;
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

/**
 * Resolve the mailbox path stored for this message. A missing folder fails closed.
 * @param {object} store Mail store.
 * @param {{ accountId: string, mailboxId: string }} message Stored message.
 * @returns {string} Provider mailbox path.
 */
function mailboxPathFor(store, message) {
  const folder = store.getFolderMetadata?.(message.accountId, message.mailboxId);
  const path = store.getFolderPath?.(message.accountId, message.mailboxId);
  if (!folder?.path || folder.path !== path) throw new Error('identity_mismatch');
  if (folder.accountId !== message.accountId || folder.id !== message.mailboxId) throw new Error('identity_mismatch');
  if (typeof path !== 'string' || path.trim() === '' || /[\r\n]/.test(path)) throw new Error('identity_mismatch');
  return path;
}

export { assertLeaseSafe };
