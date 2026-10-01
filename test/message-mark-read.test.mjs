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
import { createMessageMarkUnreadHandler, messageMarkUnreadDescription, messageMarkUnreadInputSchema } from '../src/mcp/message-mark-unread-tools.mjs';
import { createMessageReadHandler, messageReadDescription, messageReadInputSchema } from '../src/mcp/message-read-tools.mjs';
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
function serviceFor(store, registry, { failValidity = false, flags = [], fetchUid = null } = {}) {
  const calls = [];
  const service = new MailService({
    accountRegistry: registry,
    leaseBroker: {
      acquire: async () => ({ leaseId: 'lease-1' }),
      release: async () => { calls.push({ op: 'release' }); }
    },
    providerFactory: async () => ({
      fetchMessage: async (identity) => {
        calls.push({ op: 'fetch', mailbox: identity.mailboxId, uid: identity.uid, uidValidity: identity.uidValidity });
        if (Number(identity.uid) === 99) return null;
        return {
          uid: fetchUid ?? Number(identity.uid),
          uidValidity: identity.uidValidity,
          flags,
          raw: 'From: a@example.test\r\n\r\nHi',
          envelope: { subject: 'Hello' },
          attachments: []
        };
      },
      markRead: async (mailbox, uid, uidValidity) => {
        calls.push({ op: 'markRead', mailbox, uid, uidValidity });
        if (failValidity || String(uidValidity) !== '42') throw new Error('identity_mismatch');
        return true;
      },
      markUnread: async (mailbox, uid, uidValidity) => {
        calls.push({ op: 'markUnread', mailbox, uid, uidValidity });
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
  const handler = createMessageMarkReadHandler({ registry, mailService: service });
  const payload = JSON.parse((await handler({ messageKey })).content[0].text);
  assert.equal(payload.messageKey, MESSAGE_KEY);
  assert.equal(payload.accountId, 'info');
  assert.equal(payload.mailboxId, 'inbox');
  assert.equal(payload.uid, 7);
  assert.equal(payload.uidValidity, '42');
  assert.deepEqual(calls.filter((call) => call.op === 'markRead'), [{
    op: 'markRead',
    mailbox: 'inbox',
    uid: 7,
    uidValidity: '42'
  }]);
  assert.equal(store.getMessage(messageKey).flags.includes('\\Seen'), false);
  assert.equal(payload.raw, undefined);
  assert.equal(payload.password, undefined);
  closeFixture(store, dir);
});

test('message_mark_read fails closed when the message key is missing', async () => {
  const { dir, store, registry } = openFixture();
  const { service, calls } = serviceFor(store, registry);
  const handler = createMessageMarkReadHandler({ registry, mailService: service });
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
  const handler = createMessageMarkReadHandler({ registry: other, mailService: service });
  const payload = JSON.parse((await handler({ messageKey: MESSAGE_KEY })).content[0].text);
  assert.equal(payload.error, 'access_denied');
  assert.equal(calls.some((call) => call.op === 'markRead'), false);
  assert.equal(store.getMessage(MESSAGE_KEY).flags.includes('\\Seen'), false);
  closeFixture(store, dir);
});

test('message_mark_read fails closed when the message key is unknown', async () => {
  const { dir, store, registry } = openFixture();
  const { service, calls } = serviceFor(store, registry);
  const handler = createMessageMarkReadHandler({ registry, mailService: service });
  const payload = JSON.parse((await handler({ messageKey: 'info:inbox:42:99' })).content[0].text);
  assert.equal(payload.error, 'source_message_not_found');
  assert.equal(calls.some((call) => call.op === 'markRead'), false);
  closeFixture(store, dir);
});

test('message_mark_read fails closed when the provider UID does not match the key', async () => {
  const { dir, store, registry } = openFixture();
  const { service, calls } = serviceFor(store, registry, { fetchUid: 8 });
  const handler = createMessageMarkReadHandler({ registry, mailService: service });
  const payload = JSON.parse((await handler({ messageKey: MESSAGE_KEY })).content[0].text);
  assert.equal(payload.error, 'identity_mismatch');
  assert.equal(calls.some((call) => call.op === 'markRead'), false);
  assert.equal(store.getMessage(MESSAGE_KEY).flags.includes('\\Seen'), false);
  closeFixture(store, dir);
});

test('message_mark_read uses the key mailbox and does not write local flags', async () => {
  const { dir, store, registry } = openFixture({ path: 'INBOX.Work' });
  const mismatch = serviceFor(store, registry, { failValidity: true });
  await assert.rejects(() => mismatch.service.markRead(MESSAGE_KEY), /identity_mismatch/);
  assert.deepEqual(mismatch.calls.filter((call) => call.op === 'markRead'), [{
    op: 'markRead',
    mailbox: 'inbox',
    uid: 7,
    uidValidity: '42'
  }]);
  assert.equal(store.getMessage(MESSAGE_KEY).flags.includes('\\Seen'), false);

  const matched = serviceFor(store, registry);
  const result = await matched.service.markRead(MESSAGE_KEY);
  assert.equal(result.mailboxId, 'inbox');
  assert.equal(result.flags.includes('\\Seen'), true);
  assert.deepEqual(matched.calls.filter((call) => call.op === 'markRead')[0].mailbox, 'inbox');
  assert.equal(store.getMessage(MESSAGE_KEY).flags.includes('\\Seen'), false);
  closeFixture(store, dir);
});

test('message_read sets \\Seen from the live message and does not write local flags', async () => {
  const { dir, store, registry, messageKey } = openFixture({ flags: ['\\Flagged'] });
  const { service, calls } = serviceFor(store, registry, { flags: ['\\Flagged'] });
  const handler = createMessageReadHandler({ registry, mailService: service });
  const payload = JSON.parse((await handler({ messageKey })).content[0].text);
  assert.equal(payload.key, MESSAGE_KEY);
  assert.equal(payload.raw.includes('Hi'), true);
  assert.equal(payload.flags.includes('\\Seen'), true);
  assert.equal(payload.flags.includes('\\Flagged'), true);
  assert.deepEqual(calls.filter((call) => call.op === 'markRead'), [{
    op: 'markRead',
    mailbox: 'inbox',
    uid: 7,
    uidValidity: '42'
  }]);
  assert.equal(calls.some((call) => call.op === 'markUnread'), false);
  assert.equal(store.getMessage(messageKey).flags.includes('\\Seen'), false);
  closeFixture(store, dir);
});

test('message_read fails closed when the provider mark fails', async () => {
  const { dir, store, registry } = openFixture();
  const { service, calls } = serviceFor(store, registry, { failValidity: true });
  const handler = createMessageReadHandler({ registry, mailService: service });
  const payload = JSON.parse((await handler({ messageKey: MESSAGE_KEY })).content[0].text);
  assert.equal(payload.error, 'identity_mismatch');
  assert.equal(payload.raw, undefined);
  assert.equal(store.getMessage(MESSAGE_KEY).flags.includes('\\Seen'), false);
  assert.equal(calls.filter((call) => call.op === 'markRead').length, 1);
  closeFixture(store, dir);
});

test('message_read fails closed on a missing key, unknown message, or denied account', async () => {
  const { dir, store, registry } = openFixture();
  const { service, calls } = serviceFor(store, registry);
  const handler = createMessageReadHandler({ registry, mailService: service });
  const missing = JSON.parse((await handler({})).content[0].text);
  const unknown = JSON.parse((await handler({ messageKey: 'info:inbox:42:99' })).content[0].text);
  assert.equal(missing.error, 'message_key_required');
  assert.equal(unknown.error, 'source_message_not_found');
  const other = createPrincipalRegistry(store, 'other-user');
  const deniedHandler = createMessageReadHandler({ registry: other, mailService: service });
  const denied = JSON.parse((await deniedHandler({ messageKey: MESSAGE_KEY })).content[0].text);
  assert.equal(denied.error, 'access_denied');
  assert.equal(calls.some((call) => call.op === 'markRead'), false);
  assert.equal(store.getMessage(MESSAGE_KEY).flags.includes('\\Seen'), false);
  closeFixture(store, dir);
});

test('message_mark_unread clears \\Seen on the provider and does not write local flags', async () => {
  const { dir, store, registry, messageKey } = openFixture({ flags: ['\\Seen', '\\Flagged'] });
  const { service, calls } = serviceFor(store, registry, { flags: ['\\Seen', '\\Flagged'] });
  const handler = createMessageMarkUnreadHandler({ registry, mailService: service });
  const payload = JSON.parse((await handler({ messageKey })).content[0].text);
  assert.equal(payload.messageKey, MESSAGE_KEY);
  assert.equal(payload.uid, 7);
  assert.equal(payload.uidValidity, '42');
  assert.equal(payload.flags.includes('\\Seen'), false);
  assert.equal(payload.flags.includes('\\Flagged'), true);
  assert.deepEqual(calls.filter((call) => call.op === 'markUnread'), [{
    op: 'markUnread',
    mailbox: 'inbox',
    uid: 7,
    uidValidity: '42'
  }]);
  assert.equal(calls.some((call) => call.op === 'markRead'), false);
  assert.equal(store.getMessage(messageKey).flags.includes('\\Seen'), true);
  assert.equal(payload.raw, undefined);
  closeFixture(store, dir);
});

test('message_mark_unread fails closed when identity or access does not match', async () => {
  const { dir, store, registry } = openFixture({ flags: ['\\Seen'] });
  const { service, calls } = serviceFor(store, registry);
  const handler = createMessageMarkUnreadHandler({ registry, mailService: service });
  const missing = JSON.parse((await handler({})).content[0].text);
  const unknown = JSON.parse((await handler({ messageKey: 'info:inbox:42:99' })).content[0].text);
  assert.equal(missing.error, 'message_key_required');
  assert.equal(unknown.error, 'source_message_not_found');
  const mismatched = serviceFor(store, registry, { flags: ['\\Seen'], fetchUid: 8 });
  const mismatch = JSON.parse((await createMessageMarkUnreadHandler({
    registry,
    mailService: mismatched.service
  })({ messageKey: MESSAGE_KEY })).content[0].text);
  assert.equal(mismatch.error, 'identity_mismatch');
  const other = createPrincipalRegistry(store, 'other-user');
  const denied = JSON.parse((await createMessageMarkUnreadHandler({
    registry: other,
    mailService: service
  })({ messageKey: MESSAGE_KEY })).content[0].text);
  assert.equal(denied.error, 'access_denied');
  assert.equal(calls.some((call) => call.op === 'markUnread'), false);
  assert.equal(store.getMessage(MESSAGE_KEY).flags.includes('\\Seen'), true);
  closeFixture(store, dir);
});

test('message_mark_unread skips STORE and local flag removal when UIDVALIDITY mismatches', async () => {
  const { dir, store, registry } = openFixture({ flags: ['\\Seen'], path: 'INBOX.Work' });
  const mismatch = serviceFor(store, registry, { failValidity: true, flags: ['\\Seen'] });
  await assert.rejects(() => mismatch.service.markUnread(MESSAGE_KEY), /identity_mismatch/);
  assert.deepEqual(mismatch.calls.filter((call) => call.op === 'markUnread'), [{
    op: 'markUnread',
    mailbox: 'inbox',
    uid: 7,
    uidValidity: '42'
  }]);
  assert.equal(store.getMessage(MESSAGE_KEY).flags.includes('\\Seen'), true);
  closeFixture(store, dir);
});

test('passive sync, IDLE, search, flags reconciliation, and attachment extraction never call STORE', () => {
  const files = [
    '../src/mail/sync-engine.mjs',
    '../src/mail/mailbox-sync.mjs',
    '../src/mail/imap-idle-connection.mjs',
    '../src/mail/inbox-idle-watcher.mjs',
    '../src/mail/message-search.mjs',
    '../src/mail/incoming-mime.mjs'
  ];
  for (const file of files) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.equal(source.includes('messageFlagsAdd'), false, file);
    assert.equal(source.includes('messageFlagsRemove'), false, file);
    assert.equal(source.includes('markRead('), false, file);
    assert.equal(source.includes('markUnread('), false, file);
  }
  const imap = readFileSync(new URL('../src/mail/imap-provider.mjs', import.meta.url), 'utf8');
  assert.equal(imap.match(/messageFlagsAdd/g)?.length, 1);
  assert.equal(imap.match(/messageFlagsRemove/g)?.length, 1);
});

test('message_read writes Seen, message_mark_unread removes Seen, and message_mark_read stays explicit', () => {
  const server = readFileSync(new URL('../src/mcp/server.mjs', import.meta.url), 'utf8');
  assert.equal(server.includes("registerTool('message_read'"), true);
  assert.equal(server.includes("registerTool('message_mark_read'"), true);
  assert.equal(server.includes("registerTool('message_mark_unread'"), true);
  assert.match(messageReadDescription, /STORE \+FLAGS \\Seen/);
  assert.match(messageReadDescription, /fails closed/);
  assert.match(messageMarkReadDescription, /STORE \+FLAGS \\Seen/);
  assert.match(messageMarkUnreadDescription, /STORE -FLAGS \\Seen/);
  assert.equal(z.object(messageReadInputSchema).safeParse({ messageKey: 'info:inbox:42:7' }).success, true);
  assert.equal(z.object(messageReadInputSchema).safeParse({ messageKey: '' }).success, false);
  assert.equal(z.object(messageMarkReadInputSchema).safeParse({ messageKey: 'info:inbox:42:7' }).success, true);
  assert.equal(z.object(messageMarkReadInputSchema).safeParse({}).success, false);
  assert.equal(z.object(messageMarkUnreadInputSchema).safeParse({ messageKey: 'info:inbox:42:7' }).success, true);
  assert.equal(z.object(messageMarkUnreadInputSchema).safeParse({ messageKey: '' }).success, false);
  const headless = readFileSync(new URL('../docs/HEADLESS-MCP.md', import.meta.url), 'utf8');
  const fullSync = readFileSync(new URL('../docs/FULL-SYNC.md', import.meta.url), 'utf8');
  assert.match(headless, /message_read[\s\S]*STORE \+FLAGS \\Seen/);
  assert.match(headless, /message_mark_unread[\s\S]*STORE -FLAGS \\Seen/);
  assert.match(fullSync, /message_read[\s\S]*\\Seen/);
  assert.match(fullSync, /message_mark_unread/);
  assert.equal(/message_read[\s\S]{0,240}does not set IMAP \\Seen/.test(headless), false);
});
