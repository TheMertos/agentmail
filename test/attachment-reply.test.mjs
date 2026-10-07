import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { simpleParser } = createRequire(import.meta.url)('mailparser');
import { createApproval, verifyApproval } from '../src/core/approval.mjs';
import { ATTACHMENT_LIMITS } from '../src/mail/attachment-policy.mjs';
import { sendAndSaveSent } from '../src/mail/send-service.mjs';
import {
  createAttachmentHandlers,
  normalizeSendPayload,
  resolveReplyAttachments
} from '../src/mcp/attachment-tools.mjs';
import { createPreviewBinding } from '../src/mcp/preview-binding.mjs';
import { SqliteMailStore } from '../src/storage/sqlite-store.mjs';
import { createPrincipalRegistry } from '../src/security/principal-scope.mjs';

const ACCOUNT = {
  id: 'gmail',
  email: 'mert@example.test',
  provider: 'gmail',
  secretRef: 'resource-gmail',
  connection: { host: 'imap.gmail.com' }
};

/**
 * Build a distinct tiny PDF so each file has its own sha256.
 * @param {string} label Marker stored in the PDF comment.
 * @returns {Buffer}
 */
function pdfNamed(label) {
  return Buffer.from(`%PDF-1.4\n1 0 obj<<>>endobj\n% ${label}\ntrailer<<>>\n%%EOF\n`);
}

const INCOMING_PDF = pdfNamed('incoming-brief');
const REPLY_A = pdfNamed('reply-a');
const REPLY_B = pdfNamed('reply-b');
const REPLY_C = pdfNamed('reply-c');
const INLINE_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);

/**
 * Open a temp store and principal registry.
 * @param {string} [principal] Runtime principal.
 * @returns {{ dir: string, store: SqliteMailStore, registry: object, cleanup: () => void }}
 */
function openScope(principal = 'mert') {
  const dir = mkdtempSync(join(tmpdir(), 'agentmail-reply-attach-'));
  const store = new SqliteMailStore(join(dir, 'mail.db'));
  const registry = createPrincipalRegistry(store, principal);
  registry.register(ACCOUNT);
  return {
    dir,
    store,
    registry,
    cleanup() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

/**
 * Stage one PDF from a regular file inside an approved root.
 * @param {ReturnType<typeof createAttachmentHandlers>} handlers Upload handlers.
 * @param {string} root Approved attachment root.
 * @param {string} filename Attachment filename.
 * @param {Buffer} content PDF bytes.
 * @returns {object} Public metadata.
 */
function uploadPdf(handlers, root, filename, content) {
  const filePath = join(root, filename);
  writeFileSync(filePath, content);
  const result = JSON.parse(handlers.attachmentUpload({
    accountId: 'gmail',
    filename,
    contentType: 'application/pdf',
    filePath
  }).content[0].text);
  assert.equal(result.error, undefined);
  return result;
}

/**
 * Wrap base64 at 76 columns.
 * @param {Buffer} content Raw bytes.
 * @returns {string}
 */
function wrapBase64(content) {
  const lines = content.toString('base64').match(/.{1,76}/g) ?? [];
  return lines.join('\r\n');
}

/**
 * Source message whose raw MIME quotes text and carries one PDF plus one inline image.
 * @returns {string}
 */
function incomingRawMime() {
  return [
    'From: jobs@example.test',
    'To: mert@example.test',
    'Subject: Brief',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="source_boundary"',
    '',
    '--source_boundary',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Please see the attached brief.',
    '--source_boundary',
    'Content-Type: application/pdf; name="incoming.pdf"',
    'Content-Transfer-Encoding: base64',
    'Content-Disposition: attachment; filename="incoming.pdf"',
    '',
    wrapBase64(INCOMING_PDF),
    '--source_boundary',
    'Content-Type: image/png; name="logo.png"',
    'Content-Transfer-Encoding: base64',
    'Content-Disposition: inline; filename="logo.png"',
    'Content-ID: <logo@example.test>',
    '',
    wrapBase64(INLINE_PNG),
    '--source_boundary--',
    ''
  ].join('\r\n');
}

/**
 * Store the incoming brief without copying its files onto a reply.
 * @param {SqliteMailStore} store Mail store.
 * @returns {string} Message key.
 */
function storeIncoming(store) {
  const raw = incomingRawMime();
  const key = 'gmail:inbox:v1:7';
  store.upsertMessage({
    accountId: 'gmail',
    mailboxId: 'inbox',
    key,
    uid: 7,
    uidValidity: 'v1',
    raw,
    flags: [],
    envelope: { subject: 'Brief', from: ['jobs@example.test'], messageId: '<brief@example.test>' },
    attachments: [{ filename: 'incoming.pdf', contentType: 'application/pdf', size: INCOMING_PDF.length }]
  });
  return key;
}

test('reply attachment list defaults to empty and does not inherit source attachments', () => {
  const inherited = [{ filename: 'incoming.pdf', contentType: 'application/pdf', size: INCOMING_PDF.length }];
  assert.deepEqual(resolveReplyAttachments(() => inherited, 'gmail', undefined), []);
  assert.deepEqual(resolveReplyAttachments(() => inherited, 'gmail', []), []);
  const scope = openScope();
  const key = storeIncoming(scope.store);
  const draft = scope.store.createDraft({
    accountId: 'gmail',
    sourceMessageKey: key,
    headers: { to: ['jobs@example.test'], subject: 'Re: Brief' },
    text: 'Thanks\n\n> Please see the attached brief.',
    html: '<p>Thanks</p>'
  });
  assert.deepEqual(scope.store.getDraft(draft.id).attachments, []);
  assert.equal(scope.store.getMessage(key).raw, incomingRawMime());
  assert.equal(scope.store.getMessage(key).attachments[0].filename, 'incoming.pdf');
  scope.cleanup();
});

test('incoming PDF is absent when a reply sends two newly staged PDFs', async () => {
  const scope = openScope();
  const handlers = createAttachmentHandlers({ store: scope.store, registry: scope.registry, attachmentRoots: [scope.dir] });
  const key = storeIncoming(scope.store);
  const first = uploadPdf(handlers, scope.dir, 'reply-a.pdf', REPLY_A);
  const second = uploadPdf(handlers, scope.dir, 'reply-b.pdf', REPLY_B);
  const attachments = resolveReplyAttachments(
    (accountId, refs) => handlers.previewAttachments(accountId, refs),
    'gmail',
    [{ id: first.id }, { id: second.id }]
  );
  const draft = scope.store.createDraft({
    accountId: 'gmail',
    sourceMessageKey: key,
    headers: { to: ['jobs@example.test'], subject: 'Re: Brief' },
    text: 'Two new files.\n\n> Please see the attached brief.',
    html: '<p>Two new files.</p><blockquote>Please see the attached brief.</blockquote>',
    attachments
  });
  const read = scope.store.getDraft(draft.id);
  assert.deepEqual(read.attachments.map((item) => item.filename), ['reply-a.pdf', 'reply-b.pdf']);
  assert.equal(JSON.stringify(read.attachments).includes('incoming.pdf'), false);
  assert.equal(JSON.stringify(read).includes(INCOMING_PDF.toString('base64')), false);

  const payload = normalizeSendPayload({
    accountId: 'gmail',
    to: ['jobs@example.test'],
    subject: 'Re: Brief',
    text: read.text,
    html: read.html,
    mime: incomingRawMime(),
    attachments
  });
  assert.deepEqual(payload.attachments.map((item) => item.sha256), [first.sha256, second.sha256]);
  handlers.assertApprovalAttachments(payload);
  const approval = createApproval(payload, { ttlSeconds: 300, now: 1_700_000_000 });
  assert.equal(verifyApproval(approval, payload, 1_700_000_100), true);
  const mime = handlers.materializeApprovedMime(payload);
  const parsed = await simpleParser(mime);
  assert.deepEqual(parsed.attachments.map((item) => item.filename), ['reply-a.pdf', 'reply-b.pdf']);
  assert.equal(Buffer.compare(parsed.attachments[0].content, REPLY_A), 0);
  assert.equal(Buffer.compare(parsed.attachments[1].content, REPLY_B), 0);
  assert.match(parsed.text, /Please see the attached brief/);
  assert.equal(mime.includes('incoming.pdf'), false);
  assert.equal(mime.includes('logo.png'), false);
  assert.equal(mime.includes(INCOMING_PDF.toString('base64')), false);
  assert.equal(mime.includes(INLINE_PNG.toString('base64')), false);
  assert.equal(scope.store.getMessage(key).raw, incomingRawMime());

  const calls = [];
  const sent = await sendAndSaveSent({
    accountId: 'gmail',
    mime,
    smtp: {
      send: async (value) => {
        calls.push(value);
        return { accepted: ['jobs@example.test'] };
      }
    },
    imap: {
      findSentMailbox: async () => 'Sent',
      append: async (_mailbox, value) => {
        calls.push(value);
        return { uid: 11 };
      },
      readByUid: async () => calls[0]
    }
  });
  assert.equal(sent.status, 'sent_and_saved');
  assert.equal(calls[0], calls[1]);
  assert.equal(calls[0].includes('incoming.pdf'), false);
  scope.cleanup();
});

test('reply preview/send MIME keeps one staged response attachment and drops source attachment', async () => {
  const scope = openScope();
  const handlers = createAttachmentHandlers({ store: scope.store, registry: scope.registry, attachmentRoots: [scope.dir] });
  const sourceKey = storeIncoming(scope.store);
  const response = uploadPdf(handlers, scope.dir, 'response.pdf', REPLY_A);
  const previewBinding = createPreviewBinding({
    store: scope.store,
    registry: scope.registry,
    pendingPreviews: new Map(),
    pendingApprovals: new Map(),
    attachmentsApi: handlers,
    now: () => 1_700_000_000
  });
  const preview = JSON.parse((await previewBinding.messagePreview({
    accountId: 'gmail',
    newText: 'Here is the response.',
    newHtml: '<p>Here is the response.</p>',
    quoteText: 'Please see the attached brief.',
    attachments: [{ id: response.id }]
  })).content[0].text);
  assert.deepEqual(preview.attachments.map((item) => item.filename), ['response.pdf']);
  const attachments = resolveReplyAttachments(
    (accountId, refs) => handlers.previewAttachments(accountId, refs),
    'gmail',
    [{ id: response.id }]
  );
  const payload = normalizeSendPayload({
    accountId: 'gmail',
    to: ['jobs@example.test'],
    subject: 'Re: Brief',
    text: 'Here is the response.',
    html: '<p>Here is the response.</p>',
    mime: incomingRawMime(),
    attachments
  });
  const mime = handlers.materializeApprovedMime(payload);
  const parsed = await simpleParser(mime);
  assert.deepEqual(parsed.attachments.map((item) => item.filename), ['response.pdf']);
  assert.equal(mime.includes('incoming.pdf'), false);
  assert.equal(mime.includes(INCOMING_PDF.toString('base64')), false);
  assert.equal(scope.store.getMessage(sourceKey).raw, incomingRawMime());

  const sentMime = [];
  const sent = await sendAndSaveSent({
    accountId: 'gmail',
    mime,
    smtp: { send: async (value) => { sentMime.push(value); return { accepted: ['jobs@example.test'] }; } },
    imap: {
      findSentMailbox: async () => 'Sent',
      append: async (_mailbox, value) => { sentMime.push(value); return { uid: 12 }; },
      readByUid: async () => sentMime[0]
    }
  });
  assert.equal(sent.status, 'sent_and_saved');
  assert.equal(sentMime[0], sentMime[1]);
  assert.deepEqual((await simpleParser(sentMime[0])).attachments.map((item) => item.filename), ['response.pdf']);
  scope.cleanup();
});

test('Turkish preview MIME preserves UTF-8 bodies, RFC 2047 subject, and one response PDF', async () => {
  const scope = openScope();
  const handlers = createAttachmentHandlers({ store: scope.store, registry: scope.registry, attachmentRoots: [scope.dir] });
  const sourceKey = storeIncoming(scope.store);
  const response = uploadPdf(handlers, scope.dir, 'response.pdf', REPLY_A);
  const pendingPreviews = new Map();
  const pendingApprovals = new Map();
  const previewBinding = createPreviewBinding({
    store: scope.store,
    registry: scope.registry,
    pendingPreviews,
    pendingApprovals,
    attachmentsApi: handlers,
    now: () => 1_700_000_000
  });
  const preview = JSON.parse((await previewBinding.messagePreview({
    accountId: 'gmail',
    newText: 'Merhaba İbrahim, Türkçe yanıt için teşekkürler.',
    newHtml: '<p>Merhaba İbrahim, Türkçe yanıt için teşekkürler.</p>',
    quoteText: 'Önceki mesaj',
    attachments: [{ id: response.id }]
  })).content[0].text);
  const subject = 'İş başvurusu için teşekkürler';
  const approval = JSON.parse((await previewBinding.sendApprovalCreate({
    previewId: preview.previewId,
    accountId: 'gmail',
    to: ['jobs@example.test'],
    subject,
    attachments: preview.attachments
  })).content[0].text);
  assert.equal(approval.error, undefined);
  const payload = pendingApprovals.get(approval.id).payload;
  assert.match(payload.mime, /Content-Type: text\/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit/);
  assert.match(payload.mime, /Content-Type: text\/html; charset=utf-8\r\nContent-Transfer-Encoding: 8bit/);
  assert.match(payload.mime, /Subject: =\?UTF-8\?B\?.+\?=/);

  const materialized = handlers.materializeApprovedMime(payload);
  assert.equal((materialized.match(/Content-Transfer-Encoding: 8bit/g) ?? []).length, 2);
  assert.match(materialized, /Subject: =\?UTF-8\?B\?.+\?=/);
  const parsed = await simpleParser(materialized);
  assert.equal(parsed.subject, subject);
  assert.match(parsed.text, /Merhaba İbrahim, Türkçe yanıt için teşekkürler/);
  assert.match(parsed.html, /Merhaba İbrahim, Türkçe yanıt için teşekkürler/);
  assert.equal((parsed.html.match(/<blockquote\b/g) ?? []).length, 1);
  assert.equal(parsed.html.includes('Professional HTML'), false);
  assert.equal(parsed.attachments.length, 1);
  assert.equal(parsed.attachments[0].filename, 'response.pdf');
  assert.equal(Buffer.compare(parsed.attachments[0].content, REPLY_A), 0);
  assert.equal((parsed.text.match(/Önceki mesaj/g) ?? []).length, 1);
  assert.equal(materialized.includes('incoming.pdf'), false);
  assert.equal(materialized.includes(INCOMING_PDF.toString('base64')), false);
  assert.equal(scope.store.getMessage(sourceKey).raw, incomingRawMime());
  scope.cleanup();
});

test('three staged attachments keep caller order and metadata', () => {
  const scope = openScope();
  const handlers = createAttachmentHandlers({ store: scope.store, registry: scope.registry, attachmentRoots: [scope.dir] });
  const gamma = uploadPdf(handlers, scope.dir, 'gamma.pdf', REPLY_C);
  const alpha = uploadPdf(handlers, scope.dir, 'alpha.pdf', REPLY_A);
  const beta = uploadPdf(handlers, scope.dir, 'beta.pdf', REPLY_B);
  const attachments = handlers.previewAttachments('gmail', [
    { id: gamma.id },
    { id: alpha.id },
    { id: beta.id }
  ]);
  assert.deepEqual(attachments, [
    { id: gamma.id, filename: 'gamma.pdf', contentType: 'application/pdf', size: REPLY_C.length, sha256: gamma.sha256 },
    { id: alpha.id, filename: 'alpha.pdf', contentType: 'application/pdf', size: REPLY_A.length, sha256: alpha.sha256 },
    { id: beta.id, filename: 'beta.pdf', contentType: 'application/pdf', size: REPLY_B.length, sha256: beta.sha256 }
  ]);
  const payload = normalizeSendPayload({
    accountId: 'gmail',
    to: ['jobs@example.test'],
    subject: 'Re: Brief',
    text: 'Three files',
    html: '<p>Three files</p>',
    mime: 'From: mert@example.test\r\nTo: jobs@example.test\r\nSubject: Re: Brief\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nThree files\r\n',
    attachments
  });
  const mime = handlers.materializeApprovedMime(payload);
  assert.match(mime, /filename="gamma\.pdf"[\s\S]*filename="alpha\.pdf"[\s\S]*filename="beta\.pdf"/);
  scope.cleanup();
});

test('duplicate staged ids and identical sha256 values are not repeated', () => {
  const scope = openScope();
  const handlers = createAttachmentHandlers({ store: scope.store, registry: scope.registry, attachmentRoots: [scope.dir] });
  const original = uploadPdf(handlers, scope.dir, 'reply-a.pdf', REPLY_A);
  const sameBytes = uploadPdf(handlers, scope.dir, 'reply-a-copy.pdf', REPLY_A);
  const other = uploadPdf(handlers, scope.dir, 'reply-b.pdf', REPLY_B);
  const attachments = handlers.previewAttachments('gmail', [
    { id: original.id },
    { id: original.id },
    { id: sameBytes.id },
    { id: other.id }
  ]);
  assert.deepEqual(attachments.map((item) => item.filename), ['reply-a.pdf', 'reply-b.pdf']);
  assert.equal(attachments[0].sha256, createHash('sha256').update(REPLY_A).digest('hex'));
  assert.notEqual(attachments[0].sha256, attachments[1].sha256);
  const payload = normalizeSendPayload({
    accountId: 'gmail',
    to: ['jobs@example.test'],
    subject: 'Re: Brief',
    text: 'Deduped',
    html: '<p>Deduped</p>',
    mime: 'From: mert@example.test\r\nTo: jobs@example.test\r\nSubject: Re: Brief\r\n\r\nDeduped',
    attachments: [attachments[0], attachments[0], {
      id: sameBytes.id,
      filename: sameBytes.filename,
      contentType: sameBytes.contentType,
      size: sameBytes.size,
      sha256: sameBytes.sha256
    }, attachments[1]]
  });
  assert.deepEqual(payload.attachments.map((item) => item.id), [original.id, other.id]);
  scope.cleanup();
});

test('tampering with one attachment in a reply set invalidates approval', () => {
  const scope = openScope();
  const handlers = createAttachmentHandlers({ store: scope.store, registry: scope.registry, attachmentRoots: [scope.dir] });
  const first = uploadPdf(handlers, scope.dir, 'reply-a.pdf', REPLY_A);
  const second = uploadPdf(handlers, scope.dir, 'reply-b.pdf', REPLY_B);
  const third = uploadPdf(handlers, scope.dir, 'gamma.pdf', REPLY_C);
  const attachments = handlers.previewAttachments('gmail', [
    { id: first.id },
    { id: second.id },
    { id: third.id }
  ]);
  const payload = normalizeSendPayload({
    accountId: 'gmail',
    to: ['jobs@example.test'],
    subject: 'Re: Brief',
    text: 'Three files',
    html: '<p>Three files</p>',
    mime: 'From: mert@example.test\r\nTo: jobs@example.test\r\nSubject: Re: Brief\r\n\r\nThree files',
    attachments
  });
  const approval = createApproval(payload, { ttlSeconds: 300, now: 1_700_000_000 });
  const tampered = {
    ...payload,
    attachments: payload.attachments.map((item, index) => (index === 1 ? { ...item, sha256: 'b'.repeat(64) } : item))
  };
  assert.equal(verifyApproval(approval, tampered, 1_700_000_100), false);
  scope.store.db.prepare('UPDATE staged_attachments SET content = ? WHERE id = ? AND account_id = ? AND owner_principal = ?')
    .run(pdfNamed('replaced-gamma'), third.id, 'gmail', 'mert');
  assert.throws(() => handlers.materializeApprovedMime(payload), /attachment_mismatch/);
  assert.equal(scope.store.getStagedAttachment({
    id: first.id,
    accountId: 'gmail',
    ownerPrincipal: 'other-user'
  }), null);
  scope.cleanup();
});

test('reply attachment count stays within the existing limit', () => {
  const scope = openScope();
  const handlers = createAttachmentHandlers({ store: scope.store, registry: scope.registry, attachmentRoots: [scope.dir] });
  const refs = [];
  for (let index = 0; index < ATTACHMENT_LIMITS.maxCount + 1; index += 1) {
    refs.push({ id: uploadPdf(handlers, scope.dir, `file-${index}.pdf`, pdfNamed(`file-${index}`)).id });
  }
  assert.throws(() => handlers.previewAttachments('gmail', refs), /attachment_limit_exceeded/);
  assert.equal(handlers.previewAttachments('gmail', refs.slice(0, ATTACHMENT_LIMITS.maxCount)).length, ATTACHMENT_LIMITS.maxCount);
  scope.cleanup();
});

test('MCP schema and docs state that source attachments are not inherited by reply', () => {
  const source = readFileSync(new URL('../src/mcp/server.mjs', import.meta.url), 'utf8');
  const docs = readFileSync(new URL('../docs/HEADLESS-MCP.md', import.meta.url), 'utf8');
  assert.match(source, /source attachments are not inherited by reply/);
  assert.match(docs, /source attachments are not inherited by reply/);
});
