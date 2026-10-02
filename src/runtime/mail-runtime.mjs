import { MailService } from '../mail/mail-service.mjs';
import { SqliteMailStore } from '../storage/sqlite-store.mjs';
import { createCredentialCache, parseCredentialCacheKey } from '../security/credential-cache.mjs';
import { createCredentialSync } from '../security/credential-sync.mjs';
import { createLeaseBroker } from '../security/lease-broker.mjs';
import { createSecretFabricClient } from '../security/secretfabric-resolver.mjs';
import { ImapProvider } from '../mail/imap-provider.mjs';
import { ImapIdleConnection } from '../mail/imap-idle-connection.mjs';
import { SmtpProvider } from '../mail/smtp-provider.mjs';
import { createPrincipalRegistry } from '../security/principal-scope.mjs';

export const IMAP_FIELDS = ['incoming.host', 'incoming.port', 'incoming.security', 'incoming.username', 'incoming.password'];
export const SMTP_FIELDS = ['outgoing.host', 'outgoing.port', 'outgoing.security', 'outgoing.username', 'outgoing.password'];
export const MAIL_CREDENTIAL_SCOPES = [
  { purpose: 'imap-sync', fieldPaths: IMAP_FIELDS },
  { purpose: 'smtp-send', fieldPaths: SMTP_FIELDS }
];

/**
 * Wire store, principal-scoped registry, encrypted credential cache, and mailService.
 * Provider access always reconciles SecretFabric into the service-owned cache, then decrypts only in this process.
 * CREDENTIAL_CACHE_KEY is required. There is no direct SecretFabric resolver fallback.
 * Does not start mailbox sync or IMAP IDLE. Interactive tools use mailService against the live provider.
 * @param {import('../config.mjs').AgentMailConfig} config Validated runtime configuration.
 * @param {{ fetchImpl?: typeof fetch, providerFactory?: Function, clock?: () => number }} [options] Optional test seams.
 * @returns {{ config: object, store: SqliteMailStore, registry: object, mailService: MailService, credentialSync: object, close: () => void }}
 */
export function createMailRuntime(config, options = {}) {
  parseCredentialCacheKey(config.credentialCacheKey);
  const store = new SqliteMailStore(config.dbPath);
  const registry = createPrincipalRegistry(store, config.principal);
  const fabricOptions = {
    baseUrl: config.secretFabricUrl,
    apiToken: config.secretFabricApiToken,
    principal: config.secretFabricPrincipal,
    fetchImpl: options.fetchImpl
  };
  const cache = createCredentialCache(store.db, config.credentialCacheKey);
  const credentialSync = createCredentialSync({
    cache,
    resolveResource: createSecretFabricClient(fabricOptions),
    clock: options.clock
  });
  const leaseBroker = createLeaseBroker({
    resolver: async ({ accountId, purpose }) => {
      const account = registry.get(accountId);
      if (!account) throw new Error('account_not_found');
      const fieldPaths = purpose === 'smtp-send' ? SMTP_FIELDS : IMAP_FIELDS;
      const status = await credentialSync.reconcile({ account, purpose, fieldPaths });
      if (status.status !== 'current') throw new Error('credential_cache_unavailable');
      return credentialSync.readForProvider(account.id, purpose);
    }
  });

  /**
   * Open an IMAP or SMTP provider with the private lease credentials.
   * @param {{ account: object, lease: { leaseId: string }, operation: string }} input
   * @returns {Promise<object>} Provider instance.
   */
  async function defaultProviderFactory({ account, lease, operation }) {
    const credentials = leaseBroker.getPrivate(lease.leaseId);
    if (!credentials) throw new Error('credential_lease_unavailable');
    if (operation === 'smtp-send') {
      return new SmtpProvider({ connection: account.connection?.smtp ?? account.connection, credentials });
    }
    if (operation === 'imap-idle') {
      return new ImapIdleConnection({ connection: account.connection?.imap ?? account.connection, credentials });
    }
    return new ImapProvider({ connection: account.connection?.imap ?? account.connection, credentials });
  }

  const mailService = new MailService({
    accountRegistry: registry,
    leaseBroker,
    providerFactory: options.providerFactory ?? defaultProviderFactory
  });

  return {
    config,
    store,
    registry,
    mailService,
    credentialSync,
    close: () => store.close()
  };
}
