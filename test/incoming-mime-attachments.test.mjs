import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { extractIncomingAttachments } from '../src/mail/incoming-mime.mjs';
import { ImapProvider } from '../src/mail/imap-provider.mjs';
import { SqliteMailStore } from '../src/storage/sqlite-store.mjs';

const PDF = Buffer.from('%PDF-1.4\n% Türkçe attachment\n%%EOF\n', 'utf8');

function base64Lines(bytes) {
  return bytes.toString('base64').match(/.{1,76}/g).join('\r\n');
}

function gmailRawMime() {
  return [
    'Delivered-To: mert@example.test',
    'From: sender@example.com',
    'To: mert@example.test',
    'Subject: Encoding test Türkçe',
    'Date: Wed, 30 Sep 2026 12:00:00 +0000',
    'Message-ID: <encoding-test@example.com>',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="outer-boundary"',
    '',
    '--outer-boundary',
    'Content-Type: multipart/alternative; boundary="alternative-boundary"',
    '',
    '--alternative-boundary',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    'Merhaba, Türkçe gövde: ğüşİ.',
    '--alternative-boundary',
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    '<p>Merhaba, <strong>Türkçe</strong> gövde: ğüşİ.</p>',
    '--alternative-boundary--',
    '--outer-boundary',
    'Content-Type: application/pdf; name="encoding-test-turkce.pdf"',
    'Content-Transfer-Encoding: base64',
    'Content-Disposition: attachment; filename="encoding-test-turkce.pdf"',
    '',
    base64Lines(PDF),
    '--outer-boundary--',
    ''
  ].join('\r\n');
}

test('extracts one PDF from nested Gmail multipart MIME without treating body alternatives as attachments', async () => {
  const raw = gmailRawMime();
  const attachments = await extractIncomingAttachments(raw);

  assert.equal(attachments.length, 1);
  assert.deepEqual(attachments[0], {
    filename: 'encoding-test-turkce.pdf',
    contentType: 'application/pdf',
    size: PDF.length,
    sha256: createHash('sha256').update(PDF).digest('hex')
  });
});

test('sync fetch, upsert, and read preserve raw MIME and expose only bounded attachment metadata', async () => {
  const raw = gmailRawMime();
  const provider = new ImapProvider({
    connection: { host: 'imap.example', port: 993 },
    credentials: { username: 'user', password: 'not-returned' }
  });
  provider.client = {
    getMailboxLock: async () => ({ release() {} }),
    status: async () => ({ messages: 1, uidValidity: 7, uidNext: 2 }),
    fetch: () => (async function* () {
      yield { uid: 1, flags: [], internalDate: new Date('2026-09-30T12:00:00Z'), envelope: null, source: Buffer.from(raw) };
    })(),
    close() {}
  };
  provider.connected = true;

  const fetched = [];
  for await (const message of provider.fetchMessages({ id: 'INBOX', path: 'INBOX' })) fetched.push(message);
  assert.equal(fetched.length, 1);
  assert.equal(fetched[0].raw, raw);
  assert.deepEqual(fetched[0].attachments, [{
    filename: 'encoding-test-turkce.pdf',
    contentType: 'application/pdf',
    size: PDF.length,
    sha256: createHash('sha256').update(PDF).digest('hex')
  }]);
  assert.equal(JSON.stringify(fetched[0].attachments).includes('not-returned'), false);
  assert.equal(Object.hasOwn(fetched[0].attachments[0], 'content'), false);
  assert.equal(Object.hasOwn(fetched[0].attachments[0], 'contentBase64'), false);

  const store = new SqliteMailStore(':memory:');
  await store.upsertMessage({
    ...fetched[0], accountId: 'gmail', mailboxId: 'INBOX', key: 'gmail:INBOX:7:1'
  });
  const read = store.getMessage('gmail:INBOX:7:1');
  assert.equal(read.raw, raw);
  assert.deepEqual(read.attachments, fetched[0].attachments);
  assert.equal(Object.hasOwn(read.attachments[0], 'content'), false);
  assert.equal(Object.hasOwn(read.attachments[0], 'contentBase64'), false);
  store.close();
});

test('upsert sanitizes incoming attachment metadata and never stores attachment bytes', async () => {
  const store = new SqliteMailStore(':memory:');
  await store.upsertMessage({
    accountId: 'gmail', mailboxId: 'INBOX', key: 'gmail:INBOX:7:2', uid: 2,
    uidValidity: '7', raw: 'raw', flags: [], envelope: null,
    attachments: [{
      filename: 'safe.pdf', contentType: 'application/pdf', size: 3,
      sha256: 'a'.repeat(64), contentBase64: 'c2VjcmV0', content: Buffer.from('secret'), secret: 'credential'
    }]
  });
  const attachments = store.getMessage('gmail:INBOX:7:2').attachments;
  assert.deepEqual(attachments, [{ filename: 'safe.pdf', contentType: 'application/pdf', size: 3, sha256: 'a'.repeat(64) }]);
  assert.equal(JSON.stringify(attachments).includes('c2VjcmV0'), false);
  assert.equal(JSON.stringify(attachments).includes('credential'), false);
  store.close();
});

test('extracts multiple attached and inline file parts but not nested body alternatives', async () => {
  const image = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const note = Buffer.from('attached note', 'utf8');
  const raw = [
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="m"', '',
    '--m', 'Content-Type: multipart/alternative; boundary="a"', '',
    '--a', 'Content-Type: text/plain; charset=utf-8', '', 'body',
    '--a', 'Content-Type: text/html; charset=utf-8', '', '<p>body</p>',
    '--a--',
    '--m', 'Content-Type: image/png', 'Content-Transfer-Encoding: base64',
    'Content-Disposition: inline; filename="inline.png"', 'Content-ID: <inline@example.test>', '', base64Lines(image),
    '--m', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64',
    'Content-Disposition: attachment; filename="notes.txt"', '', base64Lines(note),
    '--m--', ''
  ].join('\r\n');
  const attachments = await extractIncomingAttachments(raw);
  assert.deepEqual(attachments.map(({ filename }) => filename), ['inline.png', 'notes.txt']);
  assert.deepEqual(attachments.map(({ size }) => size), [image.length, note.length]);
});
