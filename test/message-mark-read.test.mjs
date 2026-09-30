import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteMailStore } from '../src/storage/sqlite-store.mjs';
import { MailService } from '../src/mail/mail-service.mjs';
import { createPrincipalRegistry } from '../src/security/principal-scope.mjs';
import * as z from 'zod/v4';
import { createMessageMarkReadHandler, messageMarkReadDescription, messageMarkReadInputSchema } from '../src/mcp/message-mark-read-tools.mjs';
import { activateTestAccount, TEST_PRINCIPAL } from './test-principal.mjs';

const MESSAGE_KEY = 'info:inbox:42:7';

/**
 * Open a temporary store with one owned account, folder, and message.
 * @param {{ flags?: string[], uid?: number, mailboxId?: string, path?: string, key?: string }} [overrides]
 * @returns {{ dir: string, store: SqliteMailStore, registry: object, messageKey: string }}
 */
function openFixture(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'agentmail-mark-read-'));
  const store = new SqliteMailStore(join(dir, 'mail.db'));
  activateTestAccount(store, {
    id: 'info',
    email: 'info@example.test',
    provider: 'imap',
    secretRef: 'opaque-ref',
    connection: { host: 'imap.example.test', port: 993 }
  });
  const mailboxId = overrides.mailboxId ?? 'inbox';
  const path = overrides.path ?? 'INBOX';
  store.upsertFolder({ accountId: 'info', id: mailboxId, path });
  const uid = overrides.uid ?? 7;
  const messageKey = overrides.key ?? `info:${mailboxId}:42:${uid}`;
  store.upsertMessage({
    key: messageKey,
    accountId: 'info',
    mailboxId,
    uid,
    uidValidity: '42',
    internalDate: '2026-09-30T00:00:00.000Z',
    flags: overrides.flags ?? [],
    envelope: { subject: 'Hello' },
    raw: 'From: a@example.test\r\n\r\nHi',
    attachments: []
  });
  return { dir, store, registry: createPrincipalRegistry(store, TEST_PRINCIPAL), messageKey };
}

/**
 * @param {SqliteMailStore} store
 * @param {string} dir
 */
function closeFixture(store, dir) {
  store.close();
  rmSync(dir, { recursive: true, force: true });
}

/**
 * @param {{ storeCalls?: object[] }} [options]
 * @returns {{ service: MailService, calls: object[] }}
 */
function serviceFor(store, registry, { failValidity = false } = {}) {
  const calls = [];
  const service = new MailService({
    accountRegistry: registry,
    leaseBroker: {
      acquire: async () => ({ leaseId: 'lease-1' }),
      release: async () => { calls.push({ op: 'release' }); }
    },
    providerFactory: async () => ({
      markRead: async (mailbox, uid, uidValidity) => {
        calls.push({ op: 'markRead', mailbox, uid, uidValidity });
        if (failValidity || String(uidValidity) !== '42') throw new Error('identity_mismatch');
        return true;
      },
      close: async () => {}
    })
  });
  return { service, calls };
}

test('message_mark_read stores \\Seen only for the exact account, mailbox, and message', async () => {
  const { dir, store, registry, messageKey } = openFixture();
  const { service, calls } = serviceFor(store, registry);
  const handler = createMessageMarkReadHandler({ store, registry, mailService: service });
  const payload = JSON.parse((await handler({ messageKey })).content[0].text);
  assert.equal(payload.messageKey, MESSAGE_KEY);
  assert.equal(payload.accountId, 'info');
  assert.equal(payload.mailboxId, 'inbox');
  assert.equal(payload.uid, 7);
  assert.equal(payload.uidValidity, '42');
  assert.deepEqual(calls.filter((call) => call.op === 'markRead'), [{
    op: 'markRead',
    mailbox: 'INBOX',
    uid: 7,
    uidValidity: '42'
  }]);
  assert.equal(store.getMessage(messageKey).flags.includes('\\Seen'), true);
  assert.equal(payload.raw, undefined);
  assert.equal(payload.password, undefined);
  closeFixture(store, dir);
});

test('message_mark_read fails closed when the message key is missing', async () => {
  const { dir, store, registry } = openFixture();
  const { service, calls } = serviceFor(store, registry);
  const handler = createMessageMarkReadHandler({ store, registry, mailService: service });
  const missing = JSON.parse((await handler({})).content[0].text);
  const blank = JSON.parse((await handler({ messageKey: '   ' })).content[0].text);
  assert.equal(missing.error, 'message_key_required');
  assert.equal(blank.error, 'message_key_required');
  assert.equal(calls.some((call) => call.op === 'markRead'), false);
  assert.equal(store.getMessage(MESSAGE_KEY).flags.includes('\\Seen'), false);
  closeFixture(store, dir);
});

test('message_mark_read fails closed when the account is not accessible', async () => {
  const { dir, store } = openFixture();
  const other = createPrincipalRegistry(store, 'other-user');
  const { service, calls } = serviceFor(store, other);
  const handler = createMessageMarkReadHandler({ store, registry: other, mailService: service });
  const payload = JSON.parse((await handler({ messageKey: MESSAGE_KEY })).content[0].text);
  assert.equal(payload.error, 'access_denied');
  assert.equal(calls.some((call) => call.op === 'markRead'), false);
  assert.equal(store.getMessage(MESSAGE_KEY).flags.includes('\\Seen'), false);
  closeFixture(store, dir);
});

test('message_mark_read fails closed when the message key is unknown', async () => {
  const { dir, store, registry } = openFixture();
  const { service, calls } = serviceFor(store, registry);
  const handler = createMessageMarkReadHandler({ store, registry, mailService: service });
  const payload = JSON.parse((await handler({ messageKey: 'info:inbox:42:99' })).content[0].text);
  assert.equal(payload.error, 'source_message_not_found');
  assert.equal(calls.some((call) => call.op === 'markRead'), false);
  closeFixture(store, dir);
});

test('message_mark_read fails closed when stored identity does not match the key', async () => {
  const { dir, store, registry } = openFixture();
  store.db.prepare('UPDATE messages SET uid = ? WHERE message_key = ?').run(8, MESSAGE_KEY);
  const { service, calls } = serviceFor(store, registry);
  const handler = createMessageMarkReadHandler({ store, registry, mailService: service });
  const payload = JSON.parse((await handler({ messageKey: MESSAGE_KEY })).content[0].text);
  assert.equal(payload.error, 'identity_mismatch');
  assert.equal(calls.some((call) => call.op === 'markRead'), false);
  closeFixture(store, dir);
});

test('message_mark_read selects the stored mailbox path and skips STORE on UIDVALIDITY mismatch', async () => {
  const { dir, store, registry } = openFixture({ path: 'INBOX.Work' });
  const mismatch = serviceFor(store, registry, { failValidity: true });
  await assert.rejects(() => mismatch.service.markRead(MESSAGE_KEY, store), /identity_mismatch/);
  assert.deepEqual(mismatch.calls.filter((call) => call.op === 'markRead'), [{
    op: 'markRead',
    mailbox: 'INBOX.Work',
    uid: 7,
    uidValidity: '42'
  }]);
  assert.equal(store.getMessage(MESSAGE_KEY).flags.includes('\\Seen'), false);

  const matched = serviceFor(store, registry);
  const result = await matched.service.markRead(MESSAGE_KEY, store);
  assert.equal(result.mailboxId, 'inbox');
  assert.deepEqual(matched.calls.filter((call) => call.op === 'markRead')[0].mailbox, 'INBOX.Work');
  closeFixture(store, dir);
});

test('passive sync, IDLE, search, and attachment extraction never call STORE', () => {
  const files = [
    '../src/mail/sync-engine.mjs',
    '../src/mail/imap-idle-connection.mjs',
    '../src/mail/inbox-idle-watcher.mjs',
    '../src/mail/message-search.mjs',
    '../src/mail/incoming-mime.mjs'
  ];
  for (const file of files) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.equal(source.includes('messageFlagsAdd'), false, file);
  }
  const imap = readFileSync(new URL('../src/mail/imap-provider.mjs', import.meta.url), 'utf8');
  assert.equal(imap.match(/messageFlagsAdd/g)?.length, 1);
});

test('message_read stays local and message_mark_read is the only Seen writer in the MCP schema', () => {
  const server = readFileSync(new URL('../src/mcp/server.mjs', import.meta.url), 'utf8');
  const readStart = server.indexOf("registerTool('message_read'");
  const readEnd = server.indexOf("registerTool('attachment_upload'");
  const readBlock = server.slice(readStart, readEnd);
  assert.equal(readBlock.includes('markRead'), false);
  assert.equal(readBlock.includes('messageFlagsAdd'), false);
  assert.match(readBlock, /does not set IMAP \\\\Seen/);
  assert.equal(server.includes("registerTool('message_mark_read'"), true);
  assert.match(messageMarkReadDescription, /STORE \+FLAGS \\Seen/);
  const parsed = z.object(messageMarkReadInputSchema).safeParse({ messageKey: 'info:inbox:42:7' });
  assert.equal(parsed.success, true);
  assert.equal(z.object(messageMarkReadInputSchema).safeParse({}).success, false);
  assert.equal(z.object(messageMarkReadInputSchema).safeParse({ messageKey: '' }).success, false);
  const headless = readFileSync(new URL('../docs/HEADLESS-MCP.md', import.meta.url), 'utf8');
  const fullSync = readFileSync(new URL('../docs/FULL-SYNC.md', import.meta.url), 'utf8');
  assert.match(headless, /message_read[\s\S]*does not set IMAP \\Seen/);
  assert.match(fullSync, /message_mark_read/);
});
