import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';
import { loadConfig } from '../config.mjs';
import { MailService } from '../mail/mail-service.mjs';
import { SqliteMailStore } from '../storage/sqlite-store.mjs';
import { createLeaseBroker } from '../security/lease-broker.mjs';
import { createSecretFabricResolver } from '../security/secretfabric-resolver.mjs';
import { ImapProvider } from '../mail/imap-provider.mjs';
import { SmtpProvider } from '../mail/smtp-provider.mjs';
import { createApproval, verifyApproval } from '../core/approval.mjs';
import { composeOutgoingMessage } from '../core/compose-message.mjs';
import { createSyncStatusHandlers } from './sync-status-tools.mjs';
import { createSyncJobService } from '../mail/sync-job-service.mjs';
import { createPrincipalRegistry } from '../security/principal-scope.mjs';

const IMAP_FIELDS = ['incoming.host', 'incoming.port', 'incoming.security', 'incoming.username', 'incoming.password'];
const SMTP_FIELDS = ['outgoing.host', 'outgoing.port', 'outgoing.security', 'outgoing.username', 'outgoing.password'];

const config = loadConfig();
const store = new SqliteMailStore(config.dbPath);
const registry = createPrincipalRegistry(store, config.principal);

const resolveCredentials = createSecretFabricResolver({ baseUrl: config.secretFabricUrl, apiToken: config.secretFabricApiToken });
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
const syncJobService = createSyncJobService({ mailService, store });
const { syncStatus, syncStatusAll } = createSyncStatusHandlers({ store, registry, syncJobService });
const server = new McpServer({ name: 'agentmail', version: '0.1.0' });
const pendingApprovals = new Map();

const text = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });

server.registerTool('mail_account_list', {
  description: 'List configured mail account metadata. Credentials are never returned.',
  inputSchema: {}
}, async () => text(registry.list()));

server.registerTool('mail_account_status', {
  description: 'Return connection status for one mail account without credentials.',
  inputSchema: { accountId: z.string().min(1) }
}, async ({ accountId }) => {
  const status = registry.status(accountId);
  if (!status) return text({ error: 'account_not_found' });
  return text(status);
});

server.registerTool('mail_account_register', {
  description: 'Register non-sensitive account metadata and an opaque Hermes credential reference. Plaintext secrets are rejected.',
  inputSchema: {
    id: z.string().min(1),
    email: z.string().email(),
    provider: z.string().min(1),
    secretRef: z.string().min(1),
    label: z.string().optional(),
    connection: z.record(z.string(), z.unknown()).optional()
  }
}, async (account) => text(registry.register(account)));

server.registerTool('message_search', {
  description: 'Search the complete local mirror across all folders for one active account.',
  inputSchema: { accountId: z.string().min(1), query: z.string().default(''), limit: z.number().int().min(1).max(200).default(50) }
}, async ({ accountId, query, limit }) => {
  try {
    registry.assertAccountAccess(accountId);
  } catch {
    return text({ error: 'access_denied' });
  }
  return text(store.searchMessages(accountId, query, limit));
});

server.registerTool('message_read', {
  description: 'Read one complete locally mirrored message by its exact message key.',
  inputSchema: { messageKey: z.string().min(1) }
}, async ({ messageKey }) => {
  const accountId = messageKey.split(':', 1)[0];
  try {
    registry.assertAccountAccess(accountId);
  } catch {
    return text({ error: 'access_denied' });
  }
  const message = store.getMessage(messageKey);
  return text(message ? { ...message, raw: message.raw } : { error: 'source_message_not_found' });
});

server.registerTool('draft_create', {
  description: 'Persist a draft with explicit account and optional exact reply source.',
  inputSchema: {
    accountId: z.string().min(1),
    sourceMessageKey: z.string().optional(),
    headers: z.record(z.string(), z.unknown()),
    text: z.string(),
    html: z.string()
  }
}, async ({ accountId, sourceMessageKey, headers, text: bodyText, html }) => {
  try {
    registry.assertAccountAccess(accountId);
  } catch {
    return text({ error: 'access_denied' });
  }
  if (sourceMessageKey && !store.getMessage(sourceMessageKey)) return text({ error: 'source_message_not_found' });
  return text(store.createDraft({ accountId, sourceMessageKey, headers, text: bodyText, html }));
});

server.registerTool('draft_read', {
  description: 'Read one persisted draft.',
  inputSchema: { draftId: z.string().uuid() }
}, async ({ draftId }) => {
  const draft = store.getDraft(draftId);
  if (!draft) return text({ error: 'draft_not_found' });
  try {
    registry.assertAccountAccess(draft.accountId);
  } catch {
    return text({ error: 'access_denied' });
  }
  return text(draft);
});

server.registerTool('draft_list', {
  description: 'List drafts for one active account.',
  inputSchema: { accountId: z.string().min(1) }
}, async ({ accountId }) => {
  try {
    registry.assertAccountAccess(accountId);
  } catch {
    return text({ error: 'access_denied' });
  }
  return text(store.listDrafts(accountId));
});

server.registerTool('mail_account_deactivate', {
  description: 'Remove an account from the active sync/connect list without deleting its local mirror.',
  inputSchema: { accountId: z.string().min(1) }
}, async ({ accountId }) => {
  try {
    return text(registry.deactivate(accountId));
  } catch (error) {
    return text({ error: error.message === 'access_denied' ? 'access_denied' : error.message });
  }
});

server.registerTool('mailbox_list', {
  description: 'List all mailboxes for an account. Requires a trusted short-lived IMAP lease; credentials are never accepted as tool arguments.',
  inputSchema: { accountId: z.string().min(1) }
}, async ({ accountId }) => {
  try {
    registry.assertAccountAccess(accountId);
    return text(await mailService.listMailboxes(accountId));
  } catch (error) {
    return text({ error: error.message === 'access_denied' ? 'access_denied' : error.message });
  }
});
server.registerTool('mailbox_sync', {
  description: 'Synchronize every folder and complete message MIME for an account into the durable local mirror.',
  inputSchema: { accountId: z.string().min(1), mode: z.enum(['full', 'incremental']).default('incremental') }
}, async ({ accountId, mode }) => {
  try {
    registry.assertAccountAccess(accountId);
    const job = syncJobService.startAccountSync(accountId, { mode });
    return text({
      accountId,
      mode,
      jobId: job.jobId,
      state: job.state,
      reused: job.reused,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      error: job.error
    });
  } catch (error) {
    return text({ error: error.message === 'access_denied' ? 'access_denied' : error.message });
  }
});

server.registerTool('mailbox_sync_all', {
  description: 'Synchronize every folder of every enabled mail account into the local mirror.',
  inputSchema: { mode: z.enum(['full', 'incremental']).default('incremental') }
}, async ({ mode }) => {
  const accountIds = registry.list().map((account) => account.id);
  const { jobs } = syncJobService.startAllAccountSync(accountIds, { mode });
  return text({
    mode,
    jobs: jobs.map((job) => ({
      accountId: job.accountId,
      jobId: job.jobId,
      state: job.state,
      reused: job.reused,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      error: job.error
    }))
  });
});

server.registerTool('sync_status', {
  description: 'Return resumable sync progress per folder for one account. Never returns credentials.',
  inputSchema: { accountId: z.string().min(1) }
}, async ({ accountId }) => syncStatus({ accountId }));

server.registerTool('sync_status_all', {
  description: 'Return resumable sync progress for every active account. Never returns credentials.',
  inputSchema: {}
}, async () => syncStatusAll());

server.registerTool('signature_create', {
  description: 'Create an account-scoped HTML/plain-text signature profile. HTML is sanitized before storage.',
  inputSchema: { accountId: z.string().min(1), name: z.string().min(1), html: z.string(), text: z.string() }
}, async ({ accountId, name, html, text: bodyText }) => {
  try {
    registry.assertAccountAccess(accountId);
  } catch {
    return text({ error: 'access_denied' });
  }
  return text(store.createSignatureProfile({ accountId, name, html, text: bodyText }));
});

server.registerTool('signature_update', {
  description: 'Update a signature profile. Creates a new version and re-sanitizes HTML.',
  inputSchema: { profileId: z.string().uuid(), name: z.string().optional(), html: z.string().optional(), text: z.string().optional(), enabled: z.boolean().optional() }
}, async ({ profileId, ...changes }) => {
  const profile = store.getSignatureProfile(profileId);
  if (!profile) return text({ error: 'signature_not_found' });
  try {
    registry.assertAccountAccess(profile.accountId);
  } catch {
    return text({ error: 'access_denied' });
  }
  try {
    return text(store.updateSignatureProfile(profileId, changes));
  } catch (error) {
    return text({ error: error.message });
  }
});

server.registerTool('signature_list', {
  description: 'List enabled signature profiles for one active account.',
  inputSchema: { accountId: z.string().min(1) }
}, async ({ accountId }) => {
  try {
    registry.assertAccountAccess(accountId);
  } catch {
    return text({ error: 'access_denied' });
  }
  return text(store.listSignatureProfiles(accountId));
});

server.registerTool('signature_set_default', {
  description: 'Set the default signature profile used for new sends on an account.',
  inputSchema: { accountId: z.string().min(1), profileId: z.string().uuid() }
}, async ({ accountId, profileId }) => {
  try {
    registry.assertAccountAccess(accountId);
    store.setDefaultSignature(accountId, profileId);
    return text({ accountId, profileId, status: 'default_set' });
  } catch (error) {
    return text({ error: error.message === 'access_denied' ? 'access_denied' : error.message });
  }
});

server.registerTool('message_preview', {
  description: 'Render the exact outgoing text/HTML from new content, the selected or default signature, and an optional quoted source. Use the returned text/html as input to send_approval_create.',
  inputSchema: {
    accountId: z.string().min(1),
    newText: z.string(),
    newHtml: z.string(),
    signatureId: z.string().uuid().optional(),
    quoteText: z.string().optional(),
    quoteHtml: z.string().optional(),
    quoteDepth: z.number().int().min(1).max(10).optional()
  }
}, async ({ accountId, newText, newHtml, signatureId, quoteText, quoteHtml, quoteDepth }) => {
  try {
    registry.assertAccountAccess(accountId);
  } catch {
    return text({ error: 'access_denied' });
  }
  let signature;
  try {
    signature = store.resolveSignatureForSend({ accountId, explicitId: signatureId });
  } catch (error) {
    return text({ error: error.message });
  }
  const composed = composeOutgoingMessage({ newText, newHtml, signature, quoteText, quoteHtml, quoteDepth });
  return text({ ...composed, signature: signature ? { id: signature.id, name: signature.name, version: signature.version } : null });
});

server.registerTool('send_approval_create', {
  description: 'Create a short-lived approval bound to the exact reviewed outgoing message. Required before message_send.',
  inputSchema: {
    accountId: z.string().min(1),
    to: z.array(z.string()).min(1),
    subject: z.string(),
    text: z.string(),
    html: z.string(),
    mime: z.string()
  }
}, async ({ accountId, to, subject, text: bodyText, html, mime }) => {
  try {
    registry.assertAccountAccess(accountId);
  } catch {
    return text({ error: 'access_denied' });
  }
  const payload = { accountId, to, subject, text: bodyText, html, mime };
  const approval = createApproval(payload, { ttlSeconds: 300 });
  pendingApprovals.set(approval.id, { approval, payload });
  return text(approval);
});

server.registerTool('message_send', {
  description: 'Send an approved outgoing MIME message, save it to Sent, and verify the copy. Requires a valid, unexpired send_approval_create result for the exact same payload.',
  inputSchema: {
    approvalId: z.string().uuid(),
    accountId: z.string().min(1),
    to: z.array(z.string()).min(1),
    subject: z.string(),
    text: z.string(),
    html: z.string(),
    mime: z.string()
  }
}, async ({ approvalId, ...payload }) => {
  const entry = pendingApprovals.get(approvalId);
  if (!entry) return text({ error: 'approval_not_found' });
  const normalizedPayload = { accountId: payload.accountId, to: payload.to, subject: payload.subject, text: payload.text, html: payload.html, mime: payload.mime };
  try {
    registry.assertAccountAccess(normalizedPayload.accountId);
  } catch {
    return text({ error: 'access_denied' });
  }
  if (!verifyApproval(entry.approval, normalizedPayload)) return text({ error: 'approval_invalid_or_expired' });
  pendingApprovals.delete(approvalId);
  try {
    return text(await mailService.sendMime(normalizedPayload.accountId, normalizedPayload.mime));
  } catch (error) {
    return text({ error: error.message });
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  process.stderr.write(`AgentMail MCP error: ${error.message}\n`);
  process.exit(1);
});
