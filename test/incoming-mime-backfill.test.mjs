import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { SqliteMailStore } from '../src/storage/sqlite-store.mjs';

const PDF = Buffer.from('%PDF-1.4\nlegacy attachment\n%%EOF\n', 'utf8');

function rawMime() {
  return [
    'From: sender@example.com', 'To: user@example.com', 'Subject: legacy',
    'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="outer"', '',
    '--outer', 'Content-Type: multipart/alternative; boundary="alt"', '',
    '--alt', 'Content-Type: text/plain', '', 'body',
    '--alt', 'Content-Type: text/html', '', '<p>body</p>',
    '--alt--', '--outer', 'Content-Type: application/pdf; name="legacy.pdf"',
    'Content-Transfer-Encoding: base64',
    'Content-Disposition: attachment; filename="legacy.pdf"', '',
    PDF.toString('base64'), '--outer--', ''
  ].join('\r\n');
}

test('backfills empty attachment metadata from legacy raw MIME without changing raw bytes', async () => {
  const store = new SqliteMailStore(':memory:');
  const raw = rawMime();
  await store.upsertMessage({
    key: 'info:INBOX:7:857', accountId: 'info', mailboxId: 'INBOX', uid: 857,
    uidValidity: '7', raw, flags: [], envelope: null, attachments: []
  });

  const before = store.getMessage('info:INBOX:7:857');
  assert.deepEqual(before.attachments, []);
  const changed = await store.backfillMessageAttachments('info:INBOX:7:857');
  assert.equal(changed, true);

  const expected = {
    filename: 'legacy.pdf', contentType: 'application/pdf', size: PDF.length,
    sha256: createHash('sha256').update(PDF).digest('hex')
  };
  const after = store.getMessage('info:INBOX:7:857');
  assert.deepEqual(after.attachments, [expected]);
  assert.equal(after.raw, raw);
  assert.equal(JSON.stringify(after.attachments).includes(PDF.toString('base64')), false);
  assert.equal(await store.backfillMessageAttachments('info:INBOX:7:857'), false);
  assert.equal(store.searchMessages({ accountId: 'info', hasAttachment: true }).total, 1);
  store.close();
});
