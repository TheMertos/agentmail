import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApproval } from '../src/core/approval.mjs';
import { createAttachmentHandlers, normalizeSendPayload } from '../src/mcp/attachment-tools.mjs';
import { createMessageSendHandler } from '../src/mcp/send-preflight.mjs';
import { createPrincipalRegistry } from '../src/security/principal-scope.mjs';
import { SqliteMailStore } from '../src/storage/sqlite-store.mjs';

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const ACCOUNT = {
  id: 'gmail',
  email: 'mert@example.test',
  provider: 'gmail',
  secretRef: 'resource-gmail',
  connection: { host: 'imap.gmail.com' }
};

/**
 * Stage a CV and build the approved send payload.
 * @param {SqliteMailStore} store Mail store.
 * @param {object} registry Principal registry.
 * @returns {{ handlers: object, payload: object, approval: object }}
 */
function approvedCv(store, registry) {
  const handlers = createAttachmentHandlers({ store, registry });
  const staged = JSON.parse(handlers.attachmentUpload({
    accountId: 'gmail',
    filename: 'Mert-Yagci-CV.pdf',
    contentType: 'application/pdf',
    contentBase64: PDF.toString('base64')
  }).content[0].text);
  const payload = normalizeSendPayload({
    accountId: 'gmail',
    to: ['jobs@example.test'],
    subject: 'Application',
    text: 'CV',
    html: '<p>CV</p>',
    mime: 'From: mert@example.test\r\nTo: jobs@example.test\r\nSubject: Application\r\n\r\nCV',
    attachments: [{ id: staged.id, filename: staged.filename, contentType: staged.contentType, size: staged.size, sha256: staged.sha256 }]
  });
  const approval = createApproval(payload, { ttlSeconds: 300, now: 1_700_000_000 });
  return { handlers, payload, approval };
}

/**
 * @param {{ sendImpl?: Function }} [options]
 */
function harness(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'agentmail-send-'));
  const store = new SqliteMailStore(join(dir, 'mail.db'));
  const registry = createPrincipalRegistry(store, 'mert');
  registry.register(ACCOUNT);
  registry.register({ ...ACCOUNT, id: 'work', email: 'work@example.test', secretRef: 'ref-work' });
  const calls = [];
  const pending = new Map();
  const mailService = {
    sendMime: async (...args) => {
      calls.push(args);
      if (options.sendImpl) return options.sendImpl(...args);
      return { status: 'sent_and_saved', accountId: args[0] };
    }
  };
  const handler = createMessageSendHandler({
    pendingApprovals: pending,
    registry,
    store,
    now: () => 1_700_000_100
  });
  return {
    store,
    registry,
    pending,
    calls,
    handler: (args) => handler(args, mailService),
    cleanup() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

test('message_send requires matching approval account, principal, and recipients before SMTP', async () => {
  const scope = harness();
  const { handlers, payload, approval } = approvedCv(scope.store, scope.registry);
  scope.pending.set(approval.id, { approval, payload, principal: 'mert' });

  const otherAccount = JSON.parse((await scope.handler({
    approvalId: approval.id,
    ...payload,
    accountId: 'work'
  })).content[0].text);
  assert.equal(otherAccount.error, 'approval_invalid_or_expired');

  const otherRecipient = JSON.parse((await scope.handler({
    approvalId: approval.id,
    ...payload,
    to: ['other@example.test']
  })).content[0].text);
  assert.equal(otherRecipient.error, 'approval_invalid_or_expired');

  scope.pending.set(approval.id, { approval, payload, principal: 'other-user' });
  const otherPrincipal = JSON.parse((await scope.handler({
    approvalId: approval.id,
    ...payload
  })).content[0].text);
  assert.equal(otherPrincipal.error, 'access_denied');

  const outsider = createPrincipalRegistry(scope.store, 'other-user');
  const deniedHandler = createMessageSendHandler({
    pendingApprovals: scope.pending,
    registry: outsider,
    store: scope.store,
    now: () => 1_700_000_100
  });
  scope.pending.set(approval.id, { approval, payload, principal: 'mert' });
  const denied = JSON.parse((await deniedHandler({
    approvalId: approval.id,
    ...payload
  }, { sendMime: async () => { throw new Error('send_should_not_run'); } })).content[0].text);
  assert.equal(denied.error, 'access_denied');
  assert.equal(scope.calls.length, 0);

  scope.pending.set(approval.id, { approval, payload, principal: 'mert' });
  const sent = JSON.parse((await scope.handler({ approvalId: approval.id, ...payload })).content[0].text);
  assert.equal(sent.status, 'sent_and_saved');
  assert.equal(scope.calls.length, 1);
  assert.equal(scope.pending.has(approval.id), false);
  assert.equal(handlers.materializeApprovedMime(payload).includes('Mert-Yagci-CV.pdf'), true);
  scope.cleanup();
});

test('message_send fails closed when staged attachment bytes change after approval', async () => {
  const scope = harness();
  const { payload, approval } = approvedCv(scope.store, scope.registry);
  scope.pending.set(approval.id, { approval, payload, principal: 'mert' });
  scope.store.db.prepare('UPDATE staged_attachments SET content = ? WHERE id = ?')
    .run(Buffer.from('%PDF-1.4\nreplaced\n'), payload.attachments[0].id);
  const result = JSON.parse((await scope.handler({ approvalId: approval.id, ...payload })).content[0].text);
  assert.equal(result.error, 'approval_invalid_or_expired');
  assert.equal(scope.calls.length, 0);
  assert.equal(scope.pending.has(approval.id), true);
  scope.cleanup();
});

test('message_send errors do not return passwords, tokens, or attachment base64', async () => {
  const encoded = PDF.toString('base64');
  const scope = harness({
    sendImpl: async () => {
      throw new Error(`AUTH password=hunter2 token=super-secret-token body=${encoded}`);
    }
  });
  const { payload, approval } = approvedCv(scope.store, scope.registry);
  scope.pending.set(approval.id, { approval, payload, principal: 'mert' });
  const body = (await scope.handler({ approvalId: approval.id, ...payload })).content[0].text;
  assert.equal(body.includes('hunter2'), false);
  assert.equal(body.includes('super-secret-token'), false);
  assert.equal(body.includes(encoded), false);
  assert.equal(body.includes('resource-gmail'), false);
  scope.cleanup();
});
