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
