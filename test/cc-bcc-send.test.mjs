import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPreviewBinding } from '../src/mcp/preview-binding.mjs';
import { createMessageSendHandler } from '../src/mcp/send-preflight.mjs';
import { SmtpProvider } from '../src/mail/smtp-provider.mjs';
import { sendAndSaveSent } from '../src/mail/send-service.mjs';
import { createPrincipalRegistry } from '../src/security/principal-scope.mjs';
import { SqliteMailStore } from '../src/storage/sqlite-store.mjs';

const NOW = 1_700_000_000;
const INFO = {
  id: 'info',
  email: 'info@mertyagci.de',
  provider: 'mailbox.org',
  secretRef: 'resource-info',
  connection: { host: 'imap.mailbox.org' }
};

/**
 * Open a principal-scoped store with the info account and a default signature.
 * @returns {{ store: SqliteMailStore, registry: object, cleanup: () => void }}
 */
function openInfo() {
  const dir = mkdtempSync(join(tmpdir(), 'agentmail-cc-bcc-'));
  const store = new SqliteMailStore(join(dir, 'mail.db'));
  const registry = createPrincipalRegistry(store, 'mert');
  registry.register(INFO);
  const profile = store.createSignatureProfile({
    accountId: 'info',
    name: 'Professional HTML',
    html: '<p><strong>Professional HTML</strong></p>',
    text: 'Plain signature line for info'
  });
  store.setDefaultSignature('info', profile.id);
  return {
    store,
    registry,
    cleanup() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

/**
 * Parse one MCP tool result.
 * @param {{ content: { text: string }[] }} result Tool response.
 * @returns {object}
 */
function parse(result) {
  return JSON.parse(result.content[0].text);
}

/**
 * Read one unfolded header value.
 * @param {string} mime Reviewed MIME.
 * @param {string} name Header name.
 * @returns {string|undefined}
 */
function header(mime, name) {
  const match = mime.match(new RegExp(`^${name}:\\s*(.*)$`, 'mi'));
  return match?.[1];
}

test('preview and approval bind optional cc and bcc into the exact reviewed MIME', async () => {
  const scope = openInfo();
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
    newText: 'Hello',
    newHtml: '<p>Hello</p>',
    cc: [' Copy@Example.test '],
    bcc: ['hidden@example.test']
  }));
  assert.equal(preview.error, undefined);
  assert.deepEqual(preview.cc, ['Copy@Example.test']);
  assert.deepEqual(preview.bcc, ['hidden@example.test']);
  const storedPreview = pendingPreviews.get(preview.previewId);
  assert.deepEqual(storedPreview.cc, ['Copy@Example.test']);
  assert.deepEqual(storedPreview.bcc, ['hidden@example.test']);

  const approved = parse(await binding.sendApprovalCreate({
    previewId: preview.previewId,
    accountId: 'info',
    to: [' jobs@example.test '],
    cc: ['Copy@Example.test'],
    bcc: ['hidden@example.test'],
    subject: 'Hello'
  }));
  assert.equal(approved.error, undefined);
  const payload = pendingApprovals.get(approved.id).payload;
  assert.deepEqual(payload.to, ['jobs@example.test']);
  assert.deepEqual(payload.cc, ['Copy@Example.test']);
  assert.deepEqual(payload.bcc, ['hidden@example.test']);
  assert.equal(header(payload.mime, 'To'), 'jobs@example.test');
  assert.equal(header(payload.mime, 'Cc'), 'Copy@Example.test');
  assert.equal(header(payload.mime, 'Bcc'), 'hidden@example.test');
  assert.deepEqual(pendingApprovals.get(approved.id).previewBinding.cc, payload.cc);
  assert.deepEqual(pendingApprovals.get(approved.id).previewBinding.bcc, payload.bcc);

  const calls = [];
  const send = createMessageSendHandler({
    pendingApprovals,
    registry: scope.registry,
    store: scope.store,
    now: () => NOW + 1
  });
  const sent = parse(await send({ approvalId: approved.id }, {
    sendMime: async (accountId, mime) => {
      calls.push({ accountId, mime });
      return { status: 'sent_and_saved', accountId };
    }
  }));
  assert.equal(sent.status, 'sent_and_saved');
  assert.equal(calls[0].accountId, 'info');
  assert.equal(header(calls[0].mime, 'To'), 'jobs@example.test');
  assert.equal(header(calls[0].mime, 'Cc'), 'Copy@Example.test');
  assert.equal(header(calls[0].mime, 'Bcc'), 'hidden@example.test');
  scope.cleanup();
});

test('tampering with cc or bcc invalidates approval before SMTP', async () => {
  const scope = openInfo();
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
    newText: 'Hello',
    newHtml: '<p>Hello</p>',
    cc: ['copy@example.test'],
    bcc: ['hidden@example.test']
  }));
  const dropped = parse(await binding.sendApprovalCreate({
    previewId: preview.previewId,
    accountId: 'info',
    to: ['jobs@example.test'],
    cc: ['copy@example.test'],
    subject: 'Hello'
  }));
  assert.equal(dropped.error, 'preview_invalid_or_expired');
  const swapped = parse(await binding.sendApprovalCreate({
    previewId: preview.previewId,
    accountId: 'info',
    to: ['jobs@example.test'],
    cc: ['other@example.test'],
    bcc: ['hidden@example.test'],
    subject: 'Hello'
  }));
  assert.equal(swapped.error, 'preview_invalid_or_expired');
  assert.equal(pendingApprovals.size, 0);

  const approved = parse(await binding.sendApprovalCreate({
    previewId: preview.previewId,
    accountId: 'info',
    to: ['jobs@example.test'],
    cc: ['copy@example.test'],
    bcc: ['hidden@example.test'],
    subject: 'Hello'
  }));
  const calls = [];
  const send = createMessageSendHandler({
    pendingApprovals,
    registry: scope.registry,
    store: scope.store,
    now: () => NOW + 1
  });
  const mail = {
    sendMime: async (...args) => {
      calls.push(args);
      return { status: 'sent_and_saved' };
    }
  };
  const changedCc = parse(await send({ approvalId: approved.id, cc: ['other@example.test'] }, mail));
  assert.equal(changedCc.error, 'approval_invalid_or_expired');
  const changedBcc = parse(await send({ approvalId: approved.id, bcc: ['other@example.test'] }, mail));
  assert.equal(changedBcc.error, 'approval_invalid_or_expired');
  assert.equal(calls.length, 0);
  assert.equal(pendingApprovals.has(approved.id), true);
  scope.cleanup();
});

test('omitted cc and bcc keep the previous To-only MIME and send path', async () => {
  const scope = openInfo();
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
    newText: 'Hello',
    newHtml: '<p>Hello</p>'
  }));
  assert.deepEqual(preview.cc, []);
  assert.deepEqual(preview.bcc, []);
  const approved = parse(await binding.sendApprovalCreate({
    previewId: preview.previewId,
    accountId: 'info',
    to: ['jobs@example.test'],
    subject: 'Hello'
  }));
  assert.equal(approved.error, undefined);
  const mime = pendingApprovals.get(approved.id).payload.mime;
  assert.equal(header(mime, 'To'), 'jobs@example.test');
  assert.equal(header(mime, 'Cc'), undefined);
  assert.equal(header(mime, 'Bcc'), undefined);
  assert.deepEqual(pendingApprovals.get(approved.id).payload.cc, []);
  assert.deepEqual(pendingApprovals.get(approved.id).payload.bcc, []);

  const calls = [];
  const send = createMessageSendHandler({
    pendingApprovals,
    registry: scope.registry,
    store: scope.store,
    now: () => NOW + 1
  });
  const sent = parse(await send({ approvalId: approved.id }, {
    sendMime: async (_accountId, reviewed) => {
      calls.push(reviewed);
      return { status: 'sent_and_saved', accountId: 'info' };
    }
  }));
  assert.equal(sent.status, 'sent_and_saved');
  assert.equal(header(calls[0], 'Cc'), undefined);
  assert.equal(header(calls[0], 'Bcc'), undefined);
  scope.cleanup();
});

test('invalid cc and bcc are rejected with the same recipient rules as To', async () => {
  const scope = openInfo();
  const pendingPreviews = new Map();
  const pendingApprovals = new Map();
  const binding = createPreviewBinding({
    store: scope.store,
    registry: scope.registry,
    pendingPreviews,
    pendingApprovals,
    now: () => NOW
  });
  const badPreview = parse(await binding.messagePreview({
    accountId: 'info',
    newText: 'Hello',
    newHtml: '<p>Hello</p>',
    cc: ['not-an-address']
  }));
  assert.equal(badPreview.error, 'recipients_invalid');
  assert.equal(pendingPreviews.size, 0);

  const preview = parse(await binding.messagePreview({
    accountId: 'info',
    newText: 'Hello',
    newHtml: '<p>Hello</p>'
  }));
  const badTo = parse(await binding.sendApprovalCreate({
    previewId: preview.previewId,
    accountId: 'info',
    to: ['jobs@example.test\r\nBcc: leaked@example.test'],
    subject: 'Hello'
  }));
  assert.equal(badTo.error, 'recipients_invalid');
  const badBcc = parse(await binding.sendApprovalCreate({
    previewId: preview.previewId,
    accountId: 'info',
    to: ['jobs@example.test'],
    bcc: ['hidden'],
    subject: 'Hello'
  }));
  assert.equal(badBcc.error, 'recipients_invalid');
  assert.equal(pendingApprovals.size, 0);
  scope.cleanup();
});

test('reply-all does not copy source Cc into outgoing cc or bcc', async () => {
  const scope = openInfo();
  const sourceMessageKey = 'info:INBOX:v1:3';
  const raw = [
    'From: recipient@example.test',
    'To: info@mertyagci.de',
    'Cc: side@example.test',
    'Subject: Original',
    '',
    'Original body'
  ].join('\r\n');
  await scope.store.upsertMessage({
    accountId: 'info',
    mailboxId: 'INBOX',
    key: sourceMessageKey,
    uid: 3,
    uidValidity: 'v1',
    raw,
    flags: [],
    envelope: {
      messageId: '<original@example.test>',
      subject: 'Original',
      from: [{ address: 'recipient@example.test' }],
      to: [{ address: 'info@mertyagci.de' }],
      cc: [{ address: 'side@example.test' }]
    },
    attachments: []
  });
  const pendingPreviews = new Map();
  const pendingApprovals = new Map();
  const binding = createPreviewBinding({
    store: scope.store,
    registry: scope.registry,
    mailService: { peekMessage: async () => scope.store.getMessage(sourceMessageKey) },
    pendingPreviews,
    pendingApprovals,
    now: () => NOW
  });
  const preview = parse(await binding.messagePreview({
    accountId: 'info',
    newText: 'Reply',
    newHtml: '<p>Reply</p>',
    sourceMessageKey,
    replyMode: 'reply-all'
  }));
  assert.equal(preview.error, undefined);
  assert.deepEqual(preview.cc, []);
  assert.deepEqual(preview.bcc, []);
  const approved = parse(await binding.sendApprovalCreate({
    previewId: preview.previewId,
    accountId: 'info',
    to: ['recipient@example.test'],
    subject: 'Re: Original'
  }));
  const mime = pendingApprovals.get(approved.id).payload.mime;
  assert.equal(header(mime, 'Cc'), undefined);
  assert.equal(header(mime, 'Bcc'), undefined);
  assert.match(mime, /In-Reply-To: <original@example\.test>/);
  scope.cleanup();
});

test('SMTP provider envelope includes To, Cc, and Bcc and Sent read-back must match those headers', async () => {
  const mime = [
    'From: info@mertyagci.de',
    'To: jobs@example.test, second@example.test',
    'Cc: copy@example.test',
    'Bcc: hidden@example.test',
    'Subject: Hello',
    '',
    'Hello'
  ].join('\r\n');
  const provider = new SmtpProvider({
    connection: { host: 'smtp.example.test', port: 587, security: 'starttls' },
    credentials: { username: 'info@mertyagci.de', password: 'not-logged' }
  });
  /** @type {object[]} */
  const sent = [];
  provider.transporter = {
    sendMail: async (options) => {
      sent.push(options);
      return { accepted: options.envelope.to, messageId: '<id@example.test>' };
    },
    close() {}
  };
  const smtpResult = await provider.send(mime);
  assert.deepEqual(sent[0].envelope, {
    from: 'info@mertyagci.de',
    to: ['jobs@example.test', 'second@example.test', 'copy@example.test', 'hidden@example.test']
  });
  assert.equal(smtpResult.accepted.includes('hidden@example.test'), true);
  assert.equal(JSON.stringify(sent).includes('not-logged'), false);
  provider.close();

  let appended = '';
  const saved = await sendAndSaveSent({
    accountId: 'info',
    mime,
    smtp: { send: async () => ({ accepted: smtpResult.accepted }) },
    imap: {
      findSentMailbox: async () => 'Sent',
      append: async (_mailbox, stored) => {
        appended = stored;
        return { uid: 9 };
      },
      readByUid: async () => appended
    }
  });
  assert.equal(saved.status, 'sent_and_saved');
  assert.equal(header(appended, 'To'), 'jobs@example.test, second@example.test');
  assert.equal(header(appended, 'Cc'), 'copy@example.test');
  assert.equal(header(appended, 'Bcc'), 'hidden@example.test');

  await assert.rejects(() => sendAndSaveSent({
    accountId: 'info',
    mime,
    smtp: { send: async () => ({ accepted: ['jobs@example.test'] }) },
    imap: {
      findSentMailbox: async () => 'Sent',
      append: async () => ({ uid: 10 }),
      readByUid: async () => appended.replace('Bcc: hidden@example.test\r\n', '')
    }
  }), /sent_copy_verification_failed/);
});
