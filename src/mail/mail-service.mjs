import { syncAccount } from './sync-engine.mjs';

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
    const lease = await this.leaseBroker.acquire({ accountId, purpose: `imap-sync-${mode}`, fields: ['imap'] });
    assertLeaseSafe(lease);
    const provider = await this.providerFactory({ account, lease, operation: `imap-sync-${mode}` });
    try {
      return await syncAccount({ accountId, provider, store, mode });
    } finally {
      await provider.close?.();
      await this.leaseBroker.release?.(lease);
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
}

export { assertLeaseSafe };
