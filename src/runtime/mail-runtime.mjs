import { MailService } from '../mail/mail-service.mjs';
import { SqliteMailStore } from '../storage/sqlite-store.mjs';
import { createLeaseBroker } from '../security/lease-broker.mjs';
import { createSecretFabricResolver } from '../security/secretfabric-resolver.mjs';
import { ImapProvider } from '../mail/imap-provider.mjs';
import { SmtpProvider } from '../mail/smtp-provider.mjs';
import { createSyncJobService } from '../mail/sync-job-service.mjs';
import { createPrincipalRegistry } from '../security/principal-scope.mjs';

const IMAP_FIELDS = ['incoming.host', 'incoming.port', 'incoming.security', 'incoming.username', 'incoming.password'];
const SMTP_FIELDS = ['outgoing.host', 'outgoing.port', 'outgoing.security', 'outgoing.username', 'outgoing.password'];

/**
 * Wire store, principal-scoped registry, SecretFabric lease broker, mail sync, and job service.
 * @param {import('../config.mjs').AgentMailConfig} config Validated runtime configuration.
 * @param {{ processId?: number, isProcessAlive?: (pid: number) => boolean }} [options] Optional sync job process identity.
 * @returns {{ config: import('../config.mjs').AgentMailConfig, store: SqliteMailStore, registry: object, mailService: MailService, syncJobService: ReturnType<typeof createSyncJobService>, close: () => void }}
 */
export function createMailRuntime(config, options = {}) {
  const store = new SqliteMailStore(config.dbPath);
  const registry = createPrincipalRegistry(store, config.principal);

  const resolveCredentials = createSecretFabricResolver({
    baseUrl: config.secretFabricUrl,
    apiToken: config.secretFabricApiToken,
    principal: config.secretFabricPrincipal
  });
  const leaseBroker = createLeaseBroker({
    resolver: ({ accountId, purpose }) => {
      const account = registry.get(accountId);
      if (!account) throw new Error('account_not_found');
      const fieldPaths = purpose === 'smtp-send' ? SMTP_FIELDS : IMAP_FIELDS;
      return resolveCredentials({ resourceId: account.secretRef, purpose, fieldPaths });
    }
  });

  async function providerFactory({ account, lease, operation }) {
    const credentials = leaseBroker.getPrivate(lease.leaseId);
    if (!credentials) throw new Error('credential_lease_unavailable');
    if (operation === 'smtp-send') {
      return new SmtpProvider({ connection: account.connection?.smtp ?? account.connection, credentials });
    }
    return new ImapProvider({ connection: account.connection?.imap ?? account.connection, credentials });
  }

  const mailService = new MailService({ accountRegistry: registry, leaseBroker, providerFactory });
  const syncJobService = createSyncJobService({
    mailService,
    store,
    processId: options.processId,
    isProcessAlive: options.isProcessAlive
  });

  return {
    config,
    store,
    registry,
    mailService,
    syncJobService,
    close: () => store.close()
  };
}
