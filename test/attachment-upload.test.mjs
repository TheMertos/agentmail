import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { simpleParser } = createRequire(import.meta.url)('mailparser');
import { createApproval, verifyApproval } from '../src/core/approval.mjs';
import { sendAndSaveSent } from '../src/mail/send-service.mjs';
import {
  ATTACHMENT_LIMITS,
  assertAttachmentSetLimits,
  validateAttachmentUpload
} from '../src/mail/attachment-policy.mjs';
import { assembleOutgoingMime } from '../src/mail/outgoing-mime.mjs';
import {
  createAttachmentHandlers,
  normalizeSendPayload
} from '../src/mcp/attachment-tools.mjs';
import { SqliteMailStore } from '../src/storage/sqlite-store.mjs';
import { createPrincipalRegistry } from '../src/security/principal-scope.mjs';

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const ACCOUNT = {
  id: 'gmail',
  email: 'mert@example.test',
  provider: 'gmail',
  secretRef: 'resource-gmail',
  connection: { host: 'imap.gmail.com' }
};

/**
 * Open a temp store and principal registry.
 * @param {string} principal Runtime principal.
 * @returns {{ dir: string, store: SqliteMailStore, registry: object, cleanup: () => void }}
 */
function openScope(principal = 'mert') {
  const dir = mkdtempSync(join(tmpdir(), 'agentmail-attach-'));
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
 * Stage a CV PDF through the upload handler.
 * @param {ReturnType<typeof createAttachmentHandlers>} handlers Upload handlers.
 * @param {string} [accountId] Account id.
 * @returns {object} Public attachment metadata.
 */
function uploadCv(handlers, accountId = 'gmail') {
  const result = JSON.parse(handlers.attachmentUpload({
    accountId,
    filename: 'Mert-Yagci-CV.pdf',
    contentType: 'application/pdf',
    contentBase64: PDF.toString('base64')
  }).content[0].text);
  assert.equal(result.error, undefined);
  return result;
}

test('attachment upload stages a CV PDF and returns only metadata', () => {
  const scope = openScope();
  const handlers = createAttachmentHandlers({ store: scope.store, registry: scope.registry });
  const staged = uploadCv(handlers);
  assert.equal(staged.filename, 'Mert-Yagci-CV.pdf');
  assert.equal(staged.contentType, 'application/pdf');
  assert.equal(staged.size, PDF.length);
  assert.equal(staged.sha256, createHash('sha256').update(PDF).digest('hex'));
  assert.equal('content' in staged, false);
  assert.equal('contentBase64' in staged, false);
  assert.equal(scope.store.getStagedAttachment({
    id: staged.id,
    accountId: 'gmail',
    ownerPrincipal: 'mert'
  }).content.equals(PDF), true);
  scope.cleanup();
});

test('draft_create and draft_read keep the staged attachment list', () => {
  const scope = openScope();
  const handlers = createAttachmentHandlers({ store: scope.store, registry: scope.registry });
  const staged = uploadCv(handlers);
  const draft = scope.store.createDraft({
    accountId: 'gmail',
    headers: { to: ['jobs@example.test'], subject: 'Application' },
    text: 'CV attached',
    html: '<p>CV attached</p>',
    attachments: handlers.attachmentListForAccount('gmail', [{ id: staged.id }])
  });
  const read = scope.store.getDraft(draft.id);
  assert.deepEqual(read.attachments, [{
    id: staged.id,
    filename: staged.filename,
    contentType: staged.contentType,
    size: staged.size,
    sha256: staged.sha256
  }]);
  assert.equal(JSON.stringify(read).includes(PDF.toString('base64')), false);
  scope.cleanup();
});

test('drafts without attachments stay readable and empty', () => {
  const scope = openScope();
  const draft = scope.store.createDraft({
    accountId: 'gmail',
    headers: { subject: 'No file' },
    text: 'Hello',
    html: '<p>Hello</p>'
  });
  assert.deepEqual(scope.store.getDraft(draft.id).attachments, []);
  scope.cleanup();
});

test('message preview resolves exact attachment metadata', () => {
  const scope = openScope();
  const handlers = createAttachmentHandlers({ store: scope.store, registry: scope.registry });
  const staged = uploadCv(handlers);
  const preview = handlers.previewAttachments('gmail', [{ id: staged.id }]);
  assert.deepEqual(preview, [{
    id: staged.id,
    filename: 'Mert-Yagci-CV.pdf',
    contentType: 'application/pdf',
    size: PDF.length,
    sha256: staged.sha256
  }]);
  scope.cleanup();
});

test('approved CV PDF round-trips through multipart MIME and Sent verification', async () => {
  const scope = openScope();
  const handlers = createAttachmentHandlers({ store: scope.store, registry: scope.registry });
  const staged = uploadCv(handlers);
  const reviewed = [
    'From: mert@example.test',
    'To: jobs@example.test',
    'Subject: Application',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Please find my CV.'
  ].join('\r\n');
  const attachments = handlers.previewAttachments('gmail', [{ id: staged.id }]);
  const payload = normalizeSendPayload({
    accountId: 'gmail',
    to: ['jobs@example.test'],
    subject: 'Application',
    text: 'Please find my CV.',
    html: '<p>Please find my CV.</p>',
    mime: reviewed,
    attachments
  });
  handlers.assertApprovalAttachments(payload);
  const approval = createApproval(payload, { ttlSeconds: 300, now: 1_700_000_000 });
  assert.equal(verifyApproval(approval, payload, 1_700_000_100), true);
  const mime = handlers.materializeApprovedMime(payload);
  const parsed = await simpleParser(mime);
  assert.equal(parsed.attachments.length, 1);
  assert.equal(parsed.attachments[0].filename, 'Mert-Yagci-CV.pdf');
  assert.match(parsed.attachments[0].contentType, /^application\/pdf\b/);
  assert.equal(Buffer.compare(parsed.attachments[0].content, PDF), 0);
  assert.match(parsed.text, /Please find my CV/);

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
        return { uid: 9 };
      },
      readByUid: async () => calls[0]
    }
  });
  assert.equal(sent.status, 'sent_and_saved');
  assert.equal(calls[0], calls[1]);
  assert.equal(calls[0].includes('Mert-Yagci-CV.pdf'), true);
  scope.cleanup();
});

test('changing an attachment invalidates the approval and blocks send', () => {
  const scope = openScope();
  const handlers = createAttachmentHandlers({ store: scope.store, registry: scope.registry });
  const staged = uploadCv(handlers);
  const attachments = handlers.previewAttachments('gmail', [{ id: staged.id }]);
  const payload = normalizeSendPayload({
    accountId: 'gmail',
    to: ['jobs@example.test'],
    subject: 'Application',
    text: 'CV',
    html: '<p>CV</p>',
    mime: 'From: mert@example.test\r\nTo: jobs@example.test\r\nSubject: Application\r\n\r\nCV',
    attachments
  });
  const approval = createApproval(payload, { ttlSeconds: 300, now: 1_700_000_000 });
  const swapped = {
    ...payload,
    attachments: [{ ...attachments[0], sha256: 'a'.repeat(64) }]
  };
  assert.equal(verifyApproval(approval, swapped, 1_700_000_100), false);

  scope.store.db.prepare('UPDATE staged_attachments SET content = ? WHERE id = ? AND account_id = ? AND owner_principal = ?')
    .run(Buffer.from('%PDF-1.4\nreplaced\n'), staged.id, 'gmail', 'mert');
  assert.throws(() => handlers.materializeApprovedMime(payload), /attachment_mismatch/);
  scope.cleanup();
});

test('messages without attachments send the reviewed MIME unchanged', () => {
  const reviewed = 'From: a@example.test\r\nTo: b@example.test\r\nSubject: Hi\r\n\r\nHello';
  assert.equal(assembleOutgoingMime({ mime: reviewed, attachments: [] }), reviewed);
  const payload = normalizeSendPayload({
    accountId: 'gmail',
    to: ['b@example.test'],
    subject: 'Hi',
    text: 'Hello',
    html: '<p>Hello</p>',
    mime: reviewed
  });
  assert.deepEqual(payload.attachments, []);
  const scope = openScope();
  const handlers = createAttachmentHandlers({ store: scope.store, registry: scope.registry });
  assert.equal(handlers.materializeApprovedMime(payload), reviewed);
  scope.cleanup();
});

test('invalid uploads fail closed and never read a host path', () => {
  const pem = '-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----\n';
  const cases = [
    { filename: '../../etc/passwd', contentType: 'text/plain', contentBase64: Buffer.from('nope').toString('base64'), code: 'attachment_name_rejected' },
    { filename: '/home/mert/.ssh/id_rsa', contentType: 'text/plain', contentBase64: Buffer.from('nope').toString('base64'), code: 'attachment_name_rejected' },
    { filename: 'payload.exe', contentType: 'application/octet-stream', contentBase64: Buffer.from('MZ').toString('base64'), code: 'attachment_name_rejected' },
    { filename: '.env', contentType: 'text/plain', contentBase64: Buffer.from('A=1').toString('base64'), code: 'attachment_name_rejected' },
    { filename: 'id_rsa', contentType: 'text/plain', contentBase64: Buffer.from('key').toString('base64'), code: 'attachment_name_rejected' },
    { filename: 'credentials.json', contentType: 'application/json', contentBase64: Buffer.from('{}').toString('base64'), code: 'attachment_name_rejected' },
    { filename: 'notes.txt', contentType: 'application/x-sh', contentBase64: Buffer.from('echo').toString('base64'), code: 'attachment_type_rejected' },
    { filename: 'notes.txt', contentType: 'text/plain', contentBase64: Buffer.from(pem).toString('base64'), code: 'attachment_secret_rejected' },
    { filename: 'notes.txt', contentType: 'text/plain', contentBase64: Buffer.from('password=hunter2\n').toString('base64'), code: 'attachment_secret_rejected' },
    { filename: 'cv.pdf', contentType: 'application/pdf', contentBase64: Buffer.from('MZ-not-a-pdf').toString('base64'), code: 'attachment_type_rejected' },
    { filename: 'cv.pdf', contentType: 'application/pdf', contentBase64: Buffer.from(pem).toString('base64'), code: 'attachment_secret_rejected' },
    { filename: 'cv.pdf', contentType: 'application/pdf', path: '/etc/passwd', contentBase64: PDF.toString('base64'), code: 'attachment_path_rejected' }
  ];
  for (const input of cases) {
    assert.throws(() => validateAttachmentUpload(input), new RegExp(input.code), input.filename);
  }
  assert.throws(() => assertAttachmentSetLimits(
    Array.from({ length: ATTACHMENT_LIMITS.maxCount + 1 }, () => ({ size: 1 }))
  ), /attachment_limit_exceeded/);
  assert.throws(() => assertAttachmentSetLimits([{ size: ATTACHMENT_LIMITS.maxBytes + 1 }]), /attachment_too_large/);
});

test('attachment magic bytes and filename types are fail-closed against spoofing', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const docx = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('docx')]);
  const ole = Buffer.from('d0cf11e0a1b11ae1', 'hex');
  const accepted = [
    { filename: 'photo.png', contentType: 'image/png', content: png },
    { filename: 'photo.jpg', contentType: 'image/jpeg', content: jpeg },
    { filename: 'photo.jpeg', contentType: 'image/jpeg', content: jpeg },
    { filename: 'notes.txt', contentType: 'text/plain', content: Buffer.from('hello\n') },
    { filename: 'data.csv', contentType: 'text/csv', content: Buffer.from('a,b\n1,2\n') },
    { filename: 'letter.docx', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', content: docx },
    { filename: 'sheet.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', content: docx },
    { filename: 'letter.odt', contentType: 'application/vnd.oasis.opendocument.text', content: docx },
    { filename: 'letter.doc', contentType: 'application/msword', content: ole },
    { filename: 'anim.gif', contentType: 'image/gif', content: Buffer.from('GIF89a') },
    { filename: 'pic.webp', contentType: 'image/webp', content: Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP')]) }
  ];
  for (const input of accepted) {
    const staged = validateAttachmentUpload({
      filename: input.filename,
      contentType: input.contentType,
      contentBase64: input.content.toString('base64')
    });
    assert.equal(staged.contentType, input.contentType, input.filename);
    assert.equal(staged.content.equals(input.content), true, input.filename);
  }

  const secret = 'password=hunter2';
  const rejected = [
    { filename: 'cv.pdf', contentType: 'application/pdf', content: Buffer.concat([Buffer.from('\uFEFF'), PDF]), code: 'attachment_type_rejected' },
    { filename: 'cv.pdf', contentType: 'application/pdf', content: Buffer.from('%PDF not a header'), code: 'attachment_type_rejected' },
    { filename: 'photo.png', contentType: 'image/png', content: Buffer.from([0x89, 0x50, 0x4e, 0x47]), code: 'attachment_type_rejected' },
    { filename: 'photo.png', contentType: 'image/png', content: jpeg, code: 'attachment_type_rejected' },
    { filename: 'photo.jpg', contentType: 'image/jpeg', content: png, code: 'attachment_type_rejected' },
    { filename: 'cv.pdf', contentType: 'image/png', content: png, code: 'attachment_type_rejected' },
    { filename: 'notes.txt', contentType: 'application/pdf', content: PDF, code: 'attachment_type_rejected' },
    { filename: 'notes.txt', contentType: 'text/plain', content: PDF, code: 'attachment_type_rejected' },
    { filename: 'notes.txt', contentType: 'text/plain', content: png, code: 'attachment_type_rejected' },
    { filename: 'letter.docx', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', content: Buffer.from('PK hello'), code: 'attachment_type_rejected' },
    { filename: 'letter.doc', contentType: 'application/msword', content: Buffer.from('d0cf11e0', 'hex'), code: 'attachment_type_rejected' },
    { filename: 'payload.exe.pdf', contentType: 'application/pdf', content: PDF, code: 'attachment_name_rejected' },
    { filename: 'id_ed25519.txt', contentType: 'text/plain', content: Buffer.from('hello\n'), code: 'attachment_name_rejected' },
    { filename: 'notes.txt', contentType: 'text/plain', content: Buffer.from(`${secret}\n`), code: 'attachment_secret_rejected' }
  ];
  for (const input of rejected) {
    assert.throws(() => validateAttachmentUpload({
      filename: input.filename,
      contentType: input.contentType,
      contentBase64: input.content.toString('base64')
    }), (error) => {
      assert.equal(error.code, input.code, input.filename);
      const dumped = `${error.message} ${JSON.stringify(error)}`;
      assert.equal(dumped.includes('hunter2'), false);
      assert.equal(dumped.includes(input.content.toString('base64')), false);
      return true;
    }, input.filename);
  }
});

test('upload errors and metadata results omit base64 bytes and plaintext secrets', () => {
  const scope = openScope();
  const handlers = createAttachmentHandlers({ store: scope.store, registry: scope.registry });
  const secret = 'password=hunter2';
  const encoded = Buffer.from(`${secret}\n`).toString('base64');
  const rejected = handlers.attachmentUpload({
    accountId: 'gmail',
    filename: 'notes.txt',
    contentType: 'text/plain',
    contentBase64: encoded
  }).content[0].text;
  assert.equal(JSON.parse(rejected).error, 'attachment_secret_rejected');
  assert.equal(rejected.includes('hunter2'), false);
  assert.equal(rejected.includes(encoded), false);
  const staged = uploadCv(handlers);
  const body = JSON.stringify(staged);
  assert.equal(body.includes(PDF.toString('base64')), false);
  assert.equal(body.includes(PDF.toString('latin1')), false);
  scope.cleanup();
});

test('a PDF that mentions the word password is still accepted', () => {
  const pdf = Buffer.concat([PDF, Buffer.from('\n% curriculum password wording\n')]);
  const staged = validateAttachmentUpload({
    filename: 'Mert-Yagci-CV.pdf',
    contentType: 'application/pdf',
    contentBase64: pdf.toString('base64')
  });
  assert.equal(staged.size, pdf.length);
});

test('staged attachments are isolated by principal and account', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentmail-attach-iso-'));
  const store = new SqliteMailStore(join(dir, 'mail.db'));
  const mert = createPrincipalRegistry(store, 'mert');
  const other = createPrincipalRegistry(store, 'other-user');
  mert.register(ACCOUNT);
  mert.register({ ...ACCOUNT, id: 'work', email: 'work@example.test', secretRef: 'ref-work' });
  other.register({ ...ACCOUNT, id: 'other-mail', email: 'other@example.test', secretRef: 'ref-other' });
  const mertHandlers = createAttachmentHandlers({ store, registry: mert });
  const otherHandlers = createAttachmentHandlers({ store, registry: other });
  const staged = uploadCv(mertHandlers);

  const denied = JSON.parse(otherHandlers.attachmentUpload({
    accountId: 'gmail',
    filename: 'Mert-Yagci-CV.pdf',
    contentType: 'application/pdf',
    contentBase64: PDF.toString('base64')
  }).content[0].text);
  assert.equal(denied.error, 'access_denied');
  assert.equal(store.getStagedAttachment({
    id: staged.id,
    accountId: 'gmail',
    ownerPrincipal: 'other-user'
  }), null);
  assert.throws(() => otherHandlers.previewAttachments('other-mail', [{ id: staged.id }]), /attachment_not_found/);
  assert.throws(() => mertHandlers.previewAttachments('work', [{ id: staged.id }]), /attachment_not_found/);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('message_read and search still return stored attachment metadata', () => {
  const scope = openScope();
  scope.store.upsertMessage({
    accountId: 'gmail',
    mailboxId: 'inbox',
    key: 'gmail:inbox:v1:1',
    uid: 1,
    uidValidity: 'v1',
    raw: 'Subject: CV\r\n\r\nsee attached',
    flags: [],
    envelope: { subject: 'CV' },
    attachments: [{ filename: 'Mert-Yagci-CV.pdf', contentType: 'application/pdf', size: PDF.length }]
  });
  const message = scope.store.getMessage('gmail:inbox:v1:1');
  assert.deepEqual(message.attachments, [{
    filename: 'Mert-Yagci-CV.pdf',
    contentType: 'application/pdf',
    size: PDF.length
  }]);
  const found = scope.store.searchMessages({ accountId: 'gmail', hasAttachment: true, limit: 10 });
  const items = found.items ?? found.results ?? found;
  assert.equal(items.length, 1);
  scope.cleanup();
});

test('MCP server exposes attachment upload and attachment-aware send tools', () => {
  const source = [
    readFileSync(new URL('../src/mcp/server.mjs', import.meta.url), 'utf8'),
    readFileSync(new URL('../src/mcp/send-preflight.mjs', import.meta.url), 'utf8')
  ].join('\n');
  assert.match(source, /attachment_upload/);
  assert.match(source, /normalizeSendPayload/);
  assert.match(source, /materializeApprovedMime/);
  assert.match(source, /createMessageSendHandler/);
  const docs = readFileSync(new URL('../docs/HEADLESS-MCP.md', import.meta.url), 'utf8');
  assert.match(docs, /attachment_upload/);
});
