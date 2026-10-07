import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { composeOutgoingMessage } from '../src/core/compose-message.mjs';
import { createApproval } from '../src/core/approval.mjs';
import { createAttachmentHandlers } from '../src/mcp/attachment-tools.mjs';
import { createMessageSendHandler } from '../src/mcp/send-preflight.mjs';
import { createPrincipalRegistry } from '../src/security/principal-scope.mjs';
import { SqliteMailStore } from '../src/storage/sqlite-store.mjs';

const NOW = 1_700_000_000;
const SIGNATURE_HTML = '<p><strong>Professional HTML</strong></p>';
const SIGNATURE_TEXT = 'Plain signature line for info';
const INFO = {
  id: 'info',
  email: 'info@mertyagci.de',
  provider: 'mailbox.org',
  secretRef: 'resource-info',
  connection: { host: 'imap.mailbox.org' }
};
const GMAIL = {
  id: 'gmail',
  email: 'mert@example.test',
  provider: 'gmail',
  secretRef: 'resource-gmail',
  connection: { host: 'imap.gmail.com' }
};
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

/**
 * Open a principal-scoped store with the info account and its default signature.
 * @param {string} [principal] Runtime principal.
 * @returns {{ dir: string, store: SqliteMailStore, registry: object, profile: object, cleanup: () => void }}
 */
function openInfo(principal = 'mert') {
  const dir = mkdtempSync(join(tmpdir(), 'agentmail-preview-'));
  const store = new SqliteMailStore(join(dir, 'mail.db'));
  const registry = createPrincipalRegistry(store, principal);
  registry.register(INFO);
  registry.register(GMAIL);
  const profile = store.createSignatureProfile({
    accountId: 'info',
    name: 'Professional HTML',
    html: SIGNATURE_HTML,
    text: SIGNATURE_TEXT
  });
  store.setDefaultSignature('info', profile.id);
  return {
    dir,
    store,
    registry,
    profile,
    cleanup() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

/**
 * Build a reviewed MIME message that literally contains the given bodies.
 * @param {string} html HTML alternative.
 * @param {string} text Plain alternative.
 * @returns {string}
 */
function mimeWith(html, text) {
  return [
    'From: info@mertyagci.de',
    'To: jobs@example.test',
    'Subject: Hello',
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=utf-8',
    '',
    html,
    '',
    text
  ].join('\r\n');
}

/**
 * Parse one MCP tool result.
 * @param {{ content: { text: string }[] }} result Tool response.
 * @returns {object}
 */
function parse(result) {
  return JSON.parse(result.content[0].text);
}

test('message_send rejects stripped Professional HTML even when the approval digest matches the stripped payload', async () => {
  const scope = openInfo();
  const pending = new Map();
  const calls = [];
  const exactHtml = `<p>Hello</p>${scope.profile.html}`;
  const exactText = `Hello\n\n${scope.profile.text}`;
  const stripped = {
    accountId: 'info',
    to: ['jobs@example.test'],
    subject: 'Hello',
    text: 'Hello',
    html: '<p>Hello</p>',
    mime: mimeWith('<p>Hello</p>', 'Hello'),
    attachments: []
  };
  const approval = createApproval(stripped, { ttlSeconds: 300, now: NOW });
  pending.set(approval.id, {
    approval,
    payload: stripped,
    principal: 'mert',
    previewBinding: {
      accountId: 'info',
      principal: 'mert',
      text: exactText,
      html: exactHtml,
      attachments: []
    }
  });
  const handler = createMessageSendHandler({
    pendingApprovals: pending,
    registry: scope.registry,
    store: scope.store,
    now: () => NOW + 10
  });
  const result = parse(await handler({ approvalId: approval.id, ...stripped }, {
    sendMime: async (...args) => {
      calls.push(args);
      return { status: 'sent_and_saved', accountId: args[0] };
    }
  }));
  assert.equal(result.error, 'approval_invalid_or_expired');
  assert.equal(calls.length, 0);
  assert.equal(pending.has(approval.id), true);
  scope.cleanup();
});

test('info default signature approval sends the exact Professional HTML and rejects modified, omitted, and legacy payloads', async () => {
  const bindingUrl = new URL('../src/mcp/preview-binding.mjs', import.meta.url);
  assert.equal(existsSync(bindingUrl), true, 'preview binding not implemented');
  const serverSource = readFileSync(new URL('../src/mcp/server.mjs', import.meta.url), 'utf8');
  const sendSource = readFileSync(new URL('../src/mcp/send-preflight.mjs', import.meta.url), 'utf8');
  assert.match(serverSource, /createPreviewBinding/);
  assert.match(serverSource, /previewId/);
  assert.match(sendSource, /previewBinding/);

  const { createPreviewBinding } = await import('../src/mcp/preview-binding.mjs');
  const scope = openInfo();
  let clock = NOW;
  const pendingPreviews = new Map();
  const pendingApprovals = new Map();
  const calls = [];
  const binding = createPreviewBinding({
    store: scope.store,
    registry: scope.registry,
    pendingPreviews,
    pendingApprovals,
    now: () => clock,
    previewTtlSeconds: 300,
    approvalTtlSeconds: 300
  });
  const preview = parse(await binding.messagePreview({
    accountId: 'info',
    newText: 'Hello',
    newHtml: '<p>Hello</p>',
    quoteText: 'Quoted original'
  }));
  const composed = composeOutgoingMessage({
    newText: 'Hello',
    newHtml: '<p>Hello</p>',
    signature: { html: scope.profile.html, text: scope.profile.text },
    quoteText: 'Quoted original'
  });
  assert.equal(preview.error, undefined);
  assert.equal(preview.signature.name, 'Professional HTML');
  assert.equal(preview.signature.id, scope.profile.id);
  assert.equal(preview.html, composed.html);
  assert.equal(preview.text, composed.text);
  assert.equal(preview.html.includes(scope.profile.html), true);
  assert.equal(preview.text.includes(scope.profile.text), true);
  assert.equal(preview.text.includes('> Quoted original'), true);
  assert.equal(preview.attachments.length, 0);
  assert.match(preview.previewId, /^[0-9a-f-]{36}$/i);

  const exactMime = mimeWith(preview.html, preview.text);
  const approved = parse(await binding.sendApprovalCreate({
    previewId: preview.previewId,
    accountId: 'info',
    to: ['jobs@example.test'],
    subject: 'Hello',
    text: preview.text,
    html: preview.html,
    mime: exactMime
  }));
  assert.equal(approved.error, undefined);
  const stored = pendingApprovals.get(approved.id);
  assert.equal(stored.payload.html, preview.html);
  assert.equal(stored.payload.text, preview.text);
  assert.equal(stored.payload.html.includes(scope.profile.html), true);
  assert.equal(stored.previewBinding.html, preview.html);
  assert.equal(stored.principal, 'mert');

  const send = createMessageSendHandler({
    pendingApprovals,
    registry: scope.registry,
    store: scope.store,
    now: () => clock + 10
  });
  const sent = parse(await send({
    approvalId: approved.id,
    accountId: 'info',
    to: ['jobs@example.test'],
    subject: 'Hello',
    text: preview.text,
    html: preview.html,
    mime: exactMime
  }, {
    sendMime: async (...args) => {
      calls.push(args);
      return { status: 'sent_and_saved', accountId: args[0] };
    }
  }));
  assert.equal(sent.status, 'sent_and_saved');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'info');
  assert.equal(calls[0][1].includes(scope.profile.html), true);
  assert.equal(calls[0][1].includes(scope.profile.text), true);

  const modified = parse(await binding.sendApprovalCreate({
    previewId: preview.previewId,
    accountId: 'info',
    to: ['jobs@example.test'],
    subject: 'Hello',
    text: preview.text.replace(scope.profile.text, 'Manual override'),
    html: preview.html.replace(scope.profile.html, '<p><strong>Manual override</strong></p>'),
    mime: mimeWith('<p><strong>Manual override</strong></p>', 'Manual override')
  }));
  assert.equal(modified.error, 'preview_invalid_or_expired');

  const omitted = parse(await binding.sendApprovalCreate({
    previewId: preview.previewId,
    accountId: 'info',
    to: ['jobs@example.test'],
    subject: 'Hello',
    text: 'Hello',
    html: '<p>Hello</p>',
    mime: mimeWith('<p>Hello</p>', 'Hello')
  }));
  assert.equal(omitted.error, 'preview_invalid_or_expired');

  const mimeOverride = parse(await binding.sendApprovalCreate({
    previewId: preview.previewId,
    accountId: 'info',
    to: ['jobs@example.test'],
    subject: 'Hello',
    text: preview.text,
    html: preview.html,
    mime: mimeWith('<p>Hello</p>', 'Hello')
  }));
  assert.equal(mimeOverride.error, 'preview_invalid_or_expired');

  const legacy = parse(await binding.sendApprovalCreate({
    accountId: 'info',
    to: ['jobs@example.test'],
    subject: 'Hello',
    text: preview.text,
    html: preview.html,
    mime: exactMime
  }));
  assert.equal(legacy.error, 'preview_required');

  const otherAccount = parse(await binding.sendApprovalCreate({
    previewId: preview.previewId,
    accountId: 'gmail',
    to: ['jobs@example.test'],
    subject: 'Hello',
    text: preview.text,
    html: preview.html,
    mime: exactMime
  }));
  assert.equal(otherAccount.error, 'preview_invalid_or_expired');

  const outsider = createPrincipalRegistry(scope.store, 'other-user');
  const foreign = createPreviewBinding({
    store: scope.store,
    registry: outsider,
    pendingPreviews,
    pendingApprovals,
    now: () => clock
  });
  const otherPrincipal = parse(await foreign.sendApprovalCreate({
    previewId: preview.previewId,
    accountId: 'info',
    to: ['jobs@example.test'],
    subject: 'Hello',
    text: preview.text,
    html: preview.html,
    mime: exactMime
  }));
  assert.equal(otherPrincipal.error, 'preview_invalid_or_expired');

  clock = NOW + 301;
  const expired = parse(await binding.sendApprovalCreate({
    previewId: preview.previewId,
    accountId: 'info',
    to: ['jobs@example.test'],
    subject: 'Hello',
    text: preview.text,
    html: preview.html,
    mime: exactMime
  }));
  assert.equal(expired.error, 'preview_invalid_or_expired');
  scope.cleanup();
});

test('preview approval derives the info default signature MIME server-side and sends by approval id', async () => {
  const { createPreviewBinding } = await import('../src/mcp/preview-binding.mjs');
  const scope = openInfo();
  const pendingPreviews = new Map();
  const pendingApprovals = new Map();
  const binding = createPreviewBinding({ store: scope.store, registry: scope.registry, pendingPreviews, pendingApprovals, now: () => NOW });
  const preview = parse(await binding.messagePreview({ accountId: 'info', newText: 'Hello', newHtml: '<p>Hello</p>' }));
  const approved = parse(await binding.sendApprovalCreate({ previewId: preview.previewId, accountId: 'info', to: ['jobs@example.test'], subject: 'Hello' }));
  assert.equal(approved.error, undefined);
  assert.equal(pendingApprovals.get(approved.id).payload.text, preview.text);
  assert.equal(pendingApprovals.get(approved.id).payload.html, preview.html);
  assert.match(pendingApprovals.get(approved.id).payload.mime, /Professional HTML/);

  const calls = [];
  const send = createMessageSendHandler({ pendingApprovals, registry: scope.registry, store: scope.store, now: () => NOW + 1 });
  const sent = parse(await send({ approvalId: approved.id }, {
    sendMime: async (...args) => {
      calls.push(args);
      return { status: 'sent_and_saved', accountId: args[0] };
    }
  }));
  assert.equal(sent.status, 'sent_and_saved');
  assert.equal(calls.length, 1);
  assert.match(calls[0][1], /Professional HTML/);
  scope.cleanup();
});

test('preview approval rejects changed recipient and account without sending', async () => {
  const { createPreviewBinding } = await import('../src/mcp/preview-binding.mjs');
  const scope = openInfo();
  const pendingPreviews = new Map();
  const pendingApprovals = new Map();
  const binding = createPreviewBinding({ store: scope.store, registry: scope.registry, pendingPreviews, pendingApprovals, now: () => NOW });
  const preview = parse(await binding.messagePreview({ accountId: 'info', newText: 'Hello', newHtml: '<p>Hello</p>' }));
  const approval = parse(await binding.sendApprovalCreate({ previewId: preview.previewId, accountId: 'info', to: ['jobs@example.test'], subject: 'Hello' }));
  const send = createMessageSendHandler({ pendingApprovals, registry: scope.registry, store: scope.store, now: () => NOW + 1 });
  const calls = [];
  const mail = { sendMime: async (...args) => { calls.push(args); return { status: 'sent' }; } };
  const changedRecipient = parse(await send({ approvalId: approval.id, to: ['other@example.test'] }, mail));
  assert.equal(changedRecipient.error, 'approval_invalid_or_expired');
  const changedAccount = parse(await send({ approvalId: approval.id, accountId: 'gmail' }, mail));
  assert.equal(changedAccount.error, 'approval_invalid_or_expired');
  assert.equal(calls.length, 0);
  scope.cleanup();
});

test('send approval attachments must match the preview exactly', async () => {
  const bindingUrl = new URL('../src/mcp/preview-binding.mjs', import.meta.url);
  assert.equal(existsSync(bindingUrl), true, 'preview binding not implemented');
  const { createPreviewBinding } = await import('../src/mcp/preview-binding.mjs');
  const scope = openInfo();
  const filePath = join(scope.dir, 'Mert-Yagci-CV.pdf');
  writeFileSync(filePath, PDF);
  const handlers = createAttachmentHandlers({
    store: scope.store,
    registry: scope.registry,
    attachmentRoots: [scope.dir]
  });
  const staged = parse(handlers.attachmentUpload({
    accountId: 'info',
    filename: 'Mert-Yagci-CV.pdf',
    contentType: 'application/pdf',
    filePath
  }));
  const pendingPreviews = new Map();
  const pendingApprovals = new Map();
  const binding = createPreviewBinding({
    store: scope.store,
    registry: scope.registry,
    pendingPreviews,
    pendingApprovals,
    now: () => NOW
  });
  const preview = parse(await binding.messagePreview({
    accountId: 'info',
    newText: 'CV',
    newHtml: '<p>CV</p>',
    attachments: [{ id: staged.id }]
  }));
  assert.equal(preview.attachments.length, 1);
  assert.equal(preview.attachments[0].sha256, staged.sha256);
  assert.equal(preview.html.includes(scope.profile.html), true);

  const exact = parse(await binding.sendApprovalCreate({
    previewId: preview.previewId,
    accountId: 'info',
    to: ['jobs@example.test'],
    subject: 'CV',
    text: preview.text,
    html: preview.html,
    mime: mimeWith(preview.html, preview.text),
    attachments: preview.attachments
  }));
  assert.equal(exact.error, undefined);
  assert.deepEqual(pendingApprovals.get(exact.id).payload.attachments, preview.attachments);

  const swapped = parse(await binding.sendApprovalCreate({
    previewId: preview.previewId,
    accountId: 'info',
    to: ['jobs@example.test'],
    subject: 'CV',
    text: preview.text,
    html: preview.html,
    mime: mimeWith(preview.html, preview.text),
    attachments: [{ ...preview.attachments[0], sha256: 'a'.repeat(64) }]
  }));
  assert.equal(swapped.error, 'preview_invalid_or_expired');

  const dropped = parse(await binding.sendApprovalCreate({
    previewId: preview.previewId,
    accountId: 'info',
    to: ['jobs@example.test'],
    subject: 'CV',
    text: preview.text,
    html: preview.html,
    mime: mimeWith(preview.html, preview.text)
  }));
  assert.equal(dropped.error, 'preview_invalid_or_expired');
  scope.cleanup();
});
