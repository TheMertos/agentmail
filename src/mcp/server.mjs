import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';
import { loadConfig } from '../config.mjs';
import { MailService } from '../mail/mail-service.mjs';
import { SqliteMailStore } from '../storage/sqlite-store.mjs';

const config = loadConfig();
const store = new SqliteMailStore(config.dbPath);
const registry = {
  get: (id) => store.getAccount(id),
  list: () => store.listActiveAccounts().map(({ secretRef, ...account }) => ({ ...account, hasCredentialReference: true })),
  status: (id) => { const account = store.getAccount(id); return account ? { id: account.id, email: account.email, provider: account.provider, enabled: account.enabled, hasCredentialReference: true } : null; },
  register: (account) => store.activateAccount(account)
};
const mailService = new MailService({ accountRegistry: registry });
const server = new McpServer({ name: 'agentmail', version: '0.1.0' });

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
  if (!registry.status(accountId)?.enabled) return text({ error: 'account_not_active' });
  return text(store.searchMessages(accountId, query, limit));
});

server.registerTool('message_read', {
  description: 'Read one complete locally mirrored message by its exact message key.',
  inputSchema: { messageKey: z.string().min(1) }
}, async ({ messageKey }) => {
  const accountId = messageKey.split(':', 1)[0];
  if (!registry.status(accountId)?.enabled) return text({ error: 'account_not_active' });
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
  if (!registry.status(accountId)?.enabled) return text({ error: 'account_not_active' });
  if (sourceMessageKey && !store.getMessage(sourceMessageKey)) return text({ error: 'source_message_not_found' });
  return text(store.createDraft({ accountId, sourceMessageKey, headers, text: bodyText, html }));
});

server.registerTool('draft_read', {
  description: 'Read one persisted draft.',
  inputSchema: { draftId: z.string().uuid() }
}, async ({ draftId }) => text(store.getDraft(draftId) ?? { error: 'draft_not_found' }));

server.registerTool('draft_list', {
  description: 'List drafts for one active account.',
  inputSchema: { accountId: z.string().min(1) }
}, async ({ accountId }) => {
  if (!registry.status(accountId)?.enabled) return text({ error: 'account_not_active' });
  return text(store.listDrafts(accountId));
});

server.registerTool('mail_account_deactivate', {
  description: 'Remove an account from the active sync/connect list without deleting its local mirror.',
  inputSchema: { accountId: z.string().min(1) }
}, async ({ accountId }) => {
  store.deactivateAccount(accountId);
  return text({ accountId, status: 'inactive', localDataRetained: true });
});

server.registerTool('mailbox_list', {
  description: 'List all mailboxes for an account. Requires a trusted short-lived IMAP lease; credentials are never accepted as tool arguments.',
  inputSchema: { accountId: z.string().min(1) }
}, async ({ accountId }) => {
  try {
    return text(await mailService.listMailboxes(accountId));
  } catch (error) {
    return text({ error: error.message });
  }
});
server.registerTool('mailbox_sync', {
  description: 'Synchronize every folder and complete message MIME for an account into the durable local mirror.',
  inputSchema: { accountId: z.string().min(1), mode: z.enum(['full', 'incremental']).default('incremental') }
}, async ({ accountId, mode }) => {
  try {
    return text(await mailService.syncAccount(accountId, { mode, store }));
  } catch (error) {
    return text({ error: error.message });
  }
});

server.registerTool('mailbox_sync_all', {
  description: 'Synchronize every folder of every enabled mail account into the local mirror.',
  inputSchema: { mode: z.enum(['full', 'incremental']).default('incremental') }
}, async ({ mode }) => {
  const results = [];
  for (const account of registry.list()) {
    try {
      results.push(await mailService.syncAccount(account.id, { mode, store }));
    } catch (error) {
      results.push({ accountId: account.id, error: error.message });
    }
  }
  return text({ mode, results });
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  process.stderr.write(`AgentMail MCP error: ${error.message}\n`);
  process.exit(1);
});
