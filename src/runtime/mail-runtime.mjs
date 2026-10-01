import { MailService } from '../mail/mail-service.mjs';
import { SqliteMailStore } from '../storage/sqlite-store.mjs';
import { createLeaseBroker } from '../security/lease-broker.mjs';
import { createSecretFabricResolver } from '../security/secretfabric-resolver.mjs';
import { ImapProvider } from '../mail/imap-provider.mjs';
import { ImapIdleConnection } from '../mail/imap-idle-connection.mjs';
import { SmtpProvider } from '../mail/smtp-provider.mjs';
import { createPrincipalRegistry } from '../security/principal-scope.mjs';

const IMAP_FIELDS = ['incoming.host', 'incoming.port', 'incoming.security', 'incoming.username', 'incoming.password'];
const SMTP_FIELDS = ['outgoing.host', 'outgoing.port', 'outgoing.security', 'outgoing.username', 'outgoing.password'];

/**
 * Wire store, principal-scoped registry, SecretFabric lease broker, and mailService.
 * Does not start mailbox sync or IMAP IDLE. Interactive tools use mailService against the live provider.
 * @param {import('../config.mjs').AgentMailConfig} config Validated runtime configuration.
 * @param {{ fetchImpl?: typeof fetch, providerFactory?: Function }} [options] Optional test seams.
 * @returns {{ config: import('../config.mjs').AgentMailConfig, store: SqliteMailStore, registry: object, mailService: MailService, close: () => void }}
 */
export function createMailRuntime(config, options = {}) {
  const store = new SqliteMailStore(config.dbPath);
  const registry = createPrincipalRegistry(store, config.principal);

  const resolveCredentials = createSecretFabricResolver({
    baseUrl: config.secretFabricUrl,
    apiToken: config.secretFabricApiToken,
    principal: config.secretFabricPrincipal,
    fetchImpl: options.fetchImpl
  });
  const leaseBroker = createLeaseBroker({
    resolver: ({ accountId, purpose }) => {
      const account = registry.get(accountId);
      if (!account) throw new Error('account_not_found');
      const fieldPaths = purpose === 'smtp-send' ? SMTP_FIELDS : IMAP_FIELDS;
      return resolveCredentials({ resourceId: account.secretRef, purpose, fieldPaths });
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
    close: () => store.close()
  };
}
