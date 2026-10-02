import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

test('reply preview carries real In-Reply-To and References into approved MIME', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentmail-reply-header-'));
  const store = new SqliteMailStore(join(dir, 'mail.db'));
  const registry = createPrincipalRegistry(store, 'mert');
  registry.register(ACCOUNT);
  const sourceMessageKey = 'gmail:INBOX:v1:7';
  await store.upsertMessage({
    accountId: 'gmail',
    mailboxId: 'INBOX',
    key: sourceMessageKey,
    uid: 7,
    uidValidity: 'v1',
    raw: 'Subject: Original\r\n\r\nOriginal body',
    flags: [],
    envelope: {
      messageId: '<original@example.test>',
      references: ['<older@example.test>'],
      subject: 'Original',
      from: [{ address: 'recipient@example.test' }],
      to: [{ address: 'mert@example.test' }]
    },
    attachments: []
  });
  const pendingPreviews = new Map();
  const pendingApprovals = new Map();
  const binding = createPreviewBinding({
    store,
    registry,
    mailService: {
      async peekMessage(key) {
        assert.equal(key, sourceMessageKey);
        return store.getMessage(sourceMessageKey);
      }
    },
    pendingPreviews,
    pendingApprovals,
    now: () => 1_700_000_000
  });

  const preview = JSON.parse((await binding.messagePreview({
    accountId: 'gmail',
    newText: 'Reply body',
    newHtml: '<p>Reply body</p>',
    sourceMessageKey,
    quoteText: 'Original body',
    quoteHtml: '<div>Original body</div>'
  })).content[0].text);
  assert.equal(preview.error, undefined);

  const approval = JSON.parse((await binding.sendApprovalCreate({
    previewId: preview.previewId,
    accountId: 'gmail',
    to: ['recipient@example.test'],
    subject: 'Re: Original'
  })).content[0].text);
  assert.equal(approval.error, undefined);
  const payload = pendingApprovals.get(approval.id).payload;
  assert.match(payload.mime, /In-Reply-To: <original@example\.test>/);
  assert.match(payload.mime, /References: <older@example\.test> <original@example\.test>/);
  assert.match(payload.mime, /Content-Type: multipart\/alternative/);

  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('sourceMessageKey reply quotes the complete source text and html once after the footer', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentmail-source-quote-'));
  const store = new SqliteMailStore(join(dir, 'mail.db'));
  const registry = createPrincipalRegistry(store, 'mert');
  registry.register(ACCOUNT);
  const sourceMessageKey = 'gmail:INBOX:v1:8';
  const sourceText = 'Line one of the original.\nLine two stays complete.';
  const sourceHtml = '<p>Line one of the original.</p><p>Line two stays complete.</p>';
  const raw = [
    'From: recipient@example.test',
    'To: mert@example.test',
    'Subject: Original',
    'MIME-Version: 1.0',
    'Content-Type: multipart/alternative; boundary="sourcequote"',
    '',
    '--sourcequote',
    'Content-Type: text/plain; charset=utf-8',
    '',
    sourceText,
    '--sourcequote',
    'Content-Type: text/html; charset=utf-8',
    '',
    sourceHtml,
    '--sourcequote--',
    ''
  ].join('\r\n');
  await store.upsertMessage({
    accountId: 'gmail',
    mailboxId: 'INBOX',
    key: sourceMessageKey,
    uid: 8,
    uidValidity: 'v1',
    raw,
    flags: [],
    envelope: {
      messageId: '<full-source@example.test>',
      subject: 'Original',
      from: [{ address: 'recipient@example.test' }],
      to: [{ address: 'mert@example.test' }]
    },
    attachments: []
  });
  const binding = createPreviewBinding({
    store,
    registry,
    mailService: {
      async peekMessage(key) {
        assert.equal(key, sourceMessageKey);
        return store.getMessage(sourceMessageKey);
      }
    },
    pendingPreviews: new Map(),
    pendingApprovals: new Map(),
    now: () => 1_700_000_000
  });

  const preview = JSON.parse((await binding.messagePreview({
    accountId: 'gmail',
    newText: 'Reply body',
    newHtml: '<p>Reply body</p>',
    sourceMessageKey,
    quoteText: 'ONLY A SNIPPET',
    quoteHtml: '<p>ONLY A SNIPPET</p>'
  })).content[0].text);

  assert.equal(preview.error, undefined);
  assert.equal(preview.text.includes('ONLY A SNIPPET'), false);
  assert.equal(preview.html.includes('ONLY A SNIPPET'), false);
  assert.equal((preview.text.match(/\[ SENT BY AI AGENT \]/g) ?? []).length, 1);
  assert.equal((preview.html.match(/\[ SENT BY AI AGENT \]/g) ?? []).length, 1);
  assert.ok(preview.text.indexOf('[ SENT BY AI AGENT ]') < preview.text.indexOf('Line one of the original.'));
  assert.ok(preview.html.indexOf('[ SENT BY AI AGENT ]') < preview.html.indexOf('Line one of the original.'));
  assert.match(preview.text, /> Line one of the original\.\n> Line two stays complete\./);
  assert.match(preview.html, /<p>Line one of the original\.<\/p><p>Line two stays complete\.<\/p>/);
  assert.equal((preview.html.match(/class="gmail_quote"/g) ?? []).length, 1);

  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('sourceMessageKey reply embeds Outlook HTML as body content inside one bordered quote', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentmail-outlook-quote-'));
  const store = new SqliteMailStore(join(dir, 'mail.db'));
  const registry = createPrincipalRegistry(store, 'mert');
  registry.register(ACCOUNT);
  const sourceMessageKey = 'gmail:INBOX:v1:9';
  const sourceText = 'Visible outlook sentence.\n> Nested prior reply';
  const sourceHtml = [
    '<html xmlns:o="urn:schemas-microsoft-com:office:office">',
    '<head>',
    '<meta http-equiv="Content-Type" content="text/html; charset=utf-8">',
    '<style>p { margin: 0 }</style>',
    '</head>',
    '<body lang="DE">',
    '<div class="WordSection1"><p>Visible outlook sentence.</p>',
    '<blockquote><p>Nested prior reply</p></blockquote></div>',
    '</body>',
    '</html>'
  ].join('');
  const raw = [
    'From: recipient@example.test',
    'To: mert@example.test',
    'Subject: Original',
    'MIME-Version: 1.0',
    'Content-Type: multipart/alternative; boundary="outlookquote"',
    '',
    '--outlookquote',
    'Content-Type: text/plain; charset=utf-8',
    '',
    sourceText,
    '--outlookquote',
    'Content-Type: text/html; charset=utf-8',
    '',
    sourceHtml,
    '--outlookquote--',
    ''
  ].join('\r\n');
  await store.upsertMessage({
    accountId: 'gmail',
    mailboxId: 'INBOX',
    key: sourceMessageKey,
    uid: 9,
    uidValidity: 'v1',
    raw,
    flags: [],
    envelope: {
      messageId: '<outlook-source@example.test>',
      subject: 'Original',
      from: [{ address: 'recipient@example.test' }],
      to: [{ address: 'mert@example.test' }]
    },
    attachments: []
  });
  const binding = createPreviewBinding({
    store,
    registry,
    mailService: {
      async peekMessage(key) {
        assert.equal(key, sourceMessageKey);
        return store.getMessage(sourceMessageKey);
      }
    },
    pendingPreviews: new Map(),
    pendingApprovals: new Map(),
    now: () => 1_700_000_000
  });

  const preview = JSON.parse((await binding.messagePreview({
    accountId: 'gmail',
    newText: 'Reply body',
    newHtml: '<p>Reply body</p>',
    sourceMessageKey,
    quoteText: 'ONLY A SNIPPET',
    quoteHtml: '<p>ONLY A SNIPPET</p>'
  })).content[0].text);

  assert.equal(preview.error, undefined);
  const quoteStart = preview.html.indexOf('<blockquote class="gmail_quote"');
  assert.ok(quoteStart >= 0);
  const quote = preview.html.slice(quoteStart);
  assert.equal((quote.match(/<\/?(?:html|head|body)\b/gi) ?? []).length, 0);
  assert.equal((quote.match(/<style\b/gi) ?? []).length, 0);
  assert.match(quote, /border-left:1px #ccc solid/);
  assert.match(quote, /padding-left:1ex/);
  assert.match(quote, /Visible outlook sentence\./);
  assert.match(quote, /<blockquote><p>Nested prior reply<\/p><\/blockquote>/);
  assert.equal((preview.html.match(/class="gmail_quote"/g) ?? []).length, 1);
  assert.equal(preview.html.includes('ONLY A SNIPPET'), false);
  assert.ok(preview.html.indexOf('[ SENT BY AI AGENT ]') < quoteStart);
  assert.match(preview.text, /> Visible outlook sentence\./);

  store.close();
  rmSync(dir, { recursive: true, force: true });
});
