import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';
import { loadConfig } from '../config.mjs';
import {
  attachmentUploadDescription,
  attachmentUploadInputSchema,
  createAttachmentHandlers,
  resolveReplyAttachments,
  stagedAttachmentRefSchema
} from './attachment-tools.mjs';
import { createMessageMarkReadHandler, messageMarkReadDescription, messageMarkReadInputSchema } from './message-mark-read-tools.mjs';
import { createMessageMarkUnreadHandler, messageMarkUnreadDescription, messageMarkUnreadInputSchema } from './message-mark-unread-tools.mjs';
import { createMessageReadHandler, messageReadDescription, messageReadInputSchema } from './message-read-tools.mjs';
import { createMessageSearchHandler, messageSearchDescription, messageSearchInputSchema } from './message-search-tools.mjs';
import { createPreviewBinding } from './preview-binding.mjs';
import { createMessageSendHandler } from './send-preflight.mjs';
import { createSyncStatusHandlers } from './sync-status-tools.mjs';
import { redactSensitiveText, redactToolError } from '../security/redact.mjs';
import { createMailRuntime } from '../runtime/mail-runtime.mjs';

const { store, registry, mailService } = createMailRuntime(loadConfig());
const { syncStatus, syncStatusAll } = createSyncStatusHandlers({ store, registry });
const messageSearch = createMessageSearchHandler({ store, registry });
const messageRead = createMessageReadHandler({ store, registry, mailService });
const messageMarkRead = createMessageMarkReadHandler({ store, registry, mailService });
const messageMarkUnread = createMessageMarkUnreadHandler({ store, registry, mailService });
const attachmentsApi = createAttachmentHandlers({ store, registry });
const server = new McpServer({ name: 'agentmail', version: '0.1.0' });
const pendingApprovals = new Map();
const pendingPreviews = new Map();
const previewBinding = createPreviewBinding({
  store,
  registry,
  pendingPreviews,
  pendingApprovals,
  attachmentsApi
});
const messageSend = createMessageSendHandler({ pendingApprovals, registry, store });

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
  description: 'Register non-sensitive account metadata and an opaque Hermes credential reference. Plaintext secrets are rejected. mail_account_register does not overwrite an existing account, secretRef, or connection.',
  inputSchema: {
    id: z.string().min(1),
    email: z.string().email(),
    provider: z.string().min(1),
    secretRef: z.string().min(1),
    label: z.string().optional(),
    connection: z.record(z.string(), z.unknown()).optional()
  }
}, async (account) => {
  try {
    return text(registry.register(account));
  } catch (error) {
    return text({ error: redactToolError(error) });
  }
});

server.registerTool('message_search', {
  description: messageSearchDescription,
  inputSchema: messageSearchInputSchema
}, async (args) => messageSearch(args));

server.registerTool('message_read', {
  description: messageReadDescription,
  inputSchema: messageReadInputSchema
}, async (args) => messageRead(args));

server.registerTool('message_mark_read', {
  description: messageMarkReadDescription,
  inputSchema: messageMarkReadInputSchema
}, async (args) => messageMarkRead(args));

server.registerTool('message_mark_unread', {
  description: messageMarkUnreadDescription,
  inputSchema: messageMarkUnreadInputSchema
}, async (args) => messageMarkUnread(args));

server.registerTool('attachment_upload', {
  description: attachmentUploadDescription,
  inputSchema: attachmentUploadInputSchema
}, async (args) => attachmentsApi.attachmentUpload(args));

server.registerTool('draft_create', {
  description: 'Persist a draft with explicit account, optional exact reply source, and optional staged attachment ids; source attachments are not inherited by reply. Only ids passed in attachments are stored, and an omitted list is empty. Attachment results are metadata only.',
  inputSchema: {
    accountId: z.string().min(1),
    sourceMessageKey: z.string().optional(),
    headers: z.record(z.string(), z.unknown()),
    text: z.string(),
    html: z.string(),
    attachments: z.array(stagedAttachmentRefSchema).optional()
  }
}, async ({ accountId, sourceMessageKey, headers, text: bodyText, html, attachments }) => {
  try {
    registry.assertAccountAccess(accountId);
  } catch {
    return text({ error: 'access_denied' });
  }
  if (sourceMessageKey && !store.getMessage(sourceMessageKey)) return text({ error: 'source_message_not_found' });
  let staged = [];
  try {
    staged = resolveReplyAttachments(
      (id, refs) => attachmentsApi.attachmentListForAccount(id, refs),
      accountId,
      attachments
    );
  } catch (error) {
    return text({ error: error.code || (error.message === 'access_denied' ? 'access_denied' : 'attachment_rejected') });
  }
  return text(store.createDraft({ accountId, sourceMessageKey, headers, text: bodyText, html, attachments: staged }));
});

server.registerTool('draft_read', {
  description: 'Read one persisted draft, including its attachment metadata list.',
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
server.registerTool('sync_status', {
  description: 'Read resumable sync progress per folder for one account from the local mirror. Does not start, enqueue, or wait for a sync. Never returns credentials.',
  inputSchema: { accountId: z.string().min(1) }
}, async ({ accountId }) => syncStatus({ accountId }));

server.registerTool('sync_status_all', {
  description: 'Read resumable sync progress for every active account from the local mirror. Does not start, enqueue, or wait for a sync. Never returns credentials.',
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
  description: 'Render the exact outgoing text/HTML from new content, the selected or default signature, and an optional quoted source. Returns a short-lived previewId bound to that text, HTML, signature, quote, attachments, account, and principal. Source attachments are not inherited by reply. Optional staged attachment ids are returned as exact filename, content type, size, and sha256 metadata; omitted ids yield an empty attachment list. send_approval_create retrieves this stored preview server-side and does not require copied text, HTML, MIME, or attachment metadata.',
  inputSchema: {
    accountId: z.string().min(1),
    newText: z.string(),
    newHtml: z.string(),
    signatureId: z.string().uuid().optional(),
    quoteText: z.string().optional(),
    quoteHtml: z.string().optional(),
    quoteDepth: z.number().int().min(1).max(10).optional(),
    sourceMessageKey: z.string().optional(),
    replyMode: z.enum(['reply', 'reply-all']).optional(),
    attachments: z.array(stagedAttachmentRefSchema).optional()
  }
}, async (args) => previewBinding.messagePreview(args));

server.registerTool('send_approval_create', {
  description: 'Create a short-lived approval from the exact stored message_preview. The server retrieves the preview text, HTML, selected/default signature, and explicit staged attachments, then builds the reviewed MIME; callers must not copy body or MIME fields. A missing preview, another account or principal, changed recipient, changed signature, or changed attachment is rejected. Required before message_send.',
  inputSchema: {
    previewId: z.string().uuid(),
    accountId: z.string().min(1),
    to: z.array(z.string()).min(1),
    subject: z.string()
  }
}, async (args) => previewBinding.sendApprovalCreate(args));

server.registerTool('message_send', {
  description: 'Send the exact server-stored payload identified by approvalId after approval and principal/account/attachment checks, save it to Sent, and verify the copy. No caller-controlled body, MIME, recipient, or attachment fields are accepted. Source attachments are never inherited.',
  inputSchema: {
    approvalId: z.string().uuid()
  }
}, async (args) => messageSend(args, mailService));

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  process.stderr.write(`AgentMail MCP error: ${redactSensitiveText(error?.message ?? '')}\n`);
  process.exit(1);
});
