import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPreviewBinding } from '../src/mcp/preview-binding.mjs';
import { resolveReplyTarget } from '../src/mail/reply-target.mjs';
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

function openInfo() {
  const dir = mkdtempSync(join(tmpdir(), 'agentmail-subject-crlf-'));
  const store = new SqliteMailStore(join(dir, 'mail.db'));
  const registry = createPrincipalRegistry(store, 'mert');
  registry.register(INFO);
  return {
    store,
    registry,
    cleanup: () => rmSync(dir, { recursive: true, force: true })
  };
}

/**
 * Parse a tool handler's text-wrapped JSON result.
 * @param {{ content: { type: string, text: string }[] }} result Tool result.
 * @returns {object}
 */
function parse(result) {
  return JSON.parse(result.content[0].text);
}

test('a subject carrying CRLF cannot smuggle an extra header into the approved MIME', async () => {
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
  const injected = parse(await binding.sendApprovalCreate({
    previewId: preview.previewId,
    accountId: 'info',
    to: ['jobs@example.test'],
    subject: 'Hello\r\nBcc: attacker@evil.test\r\nX-Injected: 1'
  }));
  assert.equal(injected.error, 'subject_invalid');
  assert.equal(pendingApprovals.size, 0);

  // A clean subject still approves normally afterward.
  const approved = parse(await binding.sendApprovalCreate({
    previewId: preview.previewId,
    accountId: 'info',
    to: ['jobs@example.test'],
    subject: 'Hello'
  }));
  assert.equal(approved.error, undefined);
  scope.cleanup();
});

test('resolveReplyTarget strips CR/LF from a hostile remote Subject header', () => {
  const message = {
    accountId: 'info',
    raw: 'Subject: test\r\n\r\nbody',
    envelope: {
      messageId: '<abc@example.test>',
      from: [{ address: 'attacker@evil.test' }],
      subject: 'Invoice\r\nBcc: attacker@evil.test\r\nX-Injected: 1'
    }
  };
  const target = resolveReplyTarget({ message, accountId: 'info', sourceMessageKey: 'info:INBOX:1:1' });
  assert.equal(/[\r\n]/.test(target.headers.subject), false);
  assert.equal(target.headers.subject, 'Re: Invoice Bcc: attacker@evil.test X-Injected: 1');
});
