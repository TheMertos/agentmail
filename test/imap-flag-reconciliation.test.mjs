import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ImapProvider } from '../src/mail/imap-provider.mjs';
import { syncAccount } from '../src/mail/sync-engine.mjs';
import { SqliteMailStore } from '../src/storage/sqlite-store.mjs';

/**
 * Open a temporary mail store.
 * @returns {{ dir: string, store: SqliteMailStore }}
 */
function openStore() {
  const dir = mkdtempSync(join(tmpdir(), 'agentmail-flags-'));
  return { dir, store: new SqliteMailStore(join(dir, 'mail.db')) };
}

/**
 * @param {SqliteMailStore} store
 * @param {string} dir
 */
function closeStore(store, dir) {
  store.close();
  rmSync(dir, { recursive: true, force: true });
}

/**
 * Insert one mirrored message.
 * @param {SqliteMailStore} store
 * @param {{ accountId?: string, mailboxId?: string, uid?: number, uidValidity?: string, flags?: string[], raw?: string, key?: string }} message
 */
async function seedMessage(store, message) {
  const accountId = message.accountId ?? 'a';
  const mailboxId = message.mailboxId ?? 'inbox';
  const uid = message.uid ?? 7;
  const uidValidity = message.uidValidity ?? '42';
  await store.upsertFolder({ accountId, id: mailboxId, path: message.path ?? 'INBOX' });
  await store.upsertMessage({
    key: message.key ?? `${accountId}:${mailboxId}:${uidValidity}:${uid}`,
    accountId,
    mailboxId,
    uid,
    uidValidity,
    internalDate: '2026-09-30T00:00:00.000Z',
    flags: message.flags ?? ['\\Seen'],
    envelope: { subject: 'Hello' },
    raw: message.raw ?? 'From: a@example.test\r\n\r\nHi',
    attachments: []
  });
}

/**
 * Connected provider double that records FETCH attributes.
 * @param {{ uidValidity?: number, batches?: Map<string, object[]> }} [options]
 * @returns {{ provider: ImapProvider, fetches: object[], stores: object[] }}
 */
function flagsProvider({ uidValidity = 42, batches = new Map() } = {}) {
  const fetches = [];
  const stores = [];
  const provider = new ImapProvider({
    connection: { host: 'imap.example', port: 993 },
    credentials: { username: 'u', password: 'p' }
  });
  provider.client = {
    connect: async () => {},
    getMailboxLock: async () => ({ release: () => {} }),
    status: async () => ({ messages: 3, uidValidity, uidNext: 10 }),
    fetch: (query, attributes, options) => {
      fetches.push({ query, attributes, options });
      const rows = batches.get(query) ?? [];
      return (async function* () {
        for (const row of rows) yield row;
      })();
    },
    messageFlagsAdd: async (...args) => {
      stores.push(args);
      throw new Error('store_not_allowed');
    },
    messageFlagsRemove: async () => { throw new Error('store_not_allowed'); },
    messageFlagsSet: async () => { throw new Error('store_not_allowed'); },
    fetchOne: async () => { throw new Error('body_not_allowed'); },
    logout: async () => {},
    close: () => {}
  };
  provider.connected = true;
  return { provider, fetches, stores };
}

test('fetchFlags requests UID and FLAGS only and does not STORE or fetch a body', async () => {
  const { provider, fetches, stores } = flagsProvider({
    batches: new Map([
      ['7', [{ uid: 7, flags: new Set(['\\Flagged']) }]]
    ])
  });
  const rows = [];
  for await (const row of provider.fetchFlags(
    { id: 'inbox', path: 'INBOX' },
    { uids: [7], uidValidity: '42', batchSize: 100 }
  )) {
    rows.push(row);
  }
  assert.equal(fetches.length, 1);
  assert.deepEqual(fetches[0].attributes, { uid: true, flags: true });
  assert.deepEqual(fetches[0].options, { uid: true });
  assert.equal(fetches[0].query, '7');
  assert.equal('source' in fetches[0].attributes, false);
  assert.equal('bodyStructure' in fetches[0].attributes, false);
  assert.equal('envelope' in fetches[0].attributes, false);
  assert.equal(stores.length, 0);
  assert.deepEqual(rows, [{ uid: 7, uidValidity: '42', flags: ['\\Flagged'] }]);
});

test('fetchFlags splits UID lists into bounded batches and skips FETCH on UIDVALIDITY mismatch', async () => {
  const { provider, fetches } = flagsProvider({
    batches: new Map([
      ['1,2', [{ uid: 1, flags: [] }, { uid: 2, flags: ['\\Seen'] }]],
      ['3', [{ uid: 3, flags: ['\\Flagged'] }]]
    ])
  });
  const rows = [];
  for await (const row of provider.fetchFlags(
    { id: 'inbox', path: 'INBOX' },
    { uids: [1, 2, 3], uidValidity: '42', batchSize: 2 }
  )) {
    rows.push(row.uid);
  }
  assert.deepEqual(fetches.map((fetch) => fetch.query), ['1,2', '3']);
  assert.deepEqual(rows, [1, 2, 3]);

  const mismatch = flagsProvider({ uidValidity: 99 });
  await assert.rejects(
    async () => {
      for await (const _row of mismatch.provider.fetchFlags(
        { id: 'inbox', path: 'INBOX' },
        { uids: [7], uidValidity: '42' }
      )) {
        // must not yield
      }
    },
    /identity_mismatch/
  );
  assert.equal(mismatch.fetches.length, 0);
  assert.equal(mismatch.stores.length, 0);
});

test('incremental sync mirrors external read and unread flags without fetching bodies or writing STORE', async () => {
  const { dir, store } = openStore();
  await seedMessage(store, { uid: 7, flags: ['\\Seen', '\\Flagged'], raw: 'KEEP-SEEN' });
  await seedMessage(store, {
    accountId: 'other',
    uid: 7,
    flags: ['\\Seen'],
    raw: 'OTHER',
    key: 'other:inbox:42:7'
  });
  await store.checkpoint({
    accountId: 'a',
    mailboxId: 'inbox',
    mode: 'incremental',
    lastUid: 7,
    uidValidity: '42',
    uidNext: 8,
    remoteMessages: 1,
    localMessageCount: 1,
    status: 'completed',
    messageCount: 1
  });
  const bodyFetches = [];
  const flagFetches = [];
  const stores = [];
  const provider = {
    async listMailboxes() {
      return [{ id: 'inbox', path: 'INBOX', messages: 1, uidNext: 8, uidValidity: '42' }];
    },
    async *fetchMessages() {
      bodyFetches.push('body');
      yield { uid: 7, uidValidity: '42', raw: 'DOWNLOADED', flags: ['\\Seen'], source: 'body' };
    },
    async *fetchFlags(mailbox, options) {
      flagFetches.push({ path: mailbox.path, uids: [...options.uids], uidValidity: options.uidValidity });
      if (String(options.uidValidity) !== '42') return;
      yield { uid: 7, uidValidity: '42', flags: ['\\Flagged'] };
    },
    async markRead() { stores.push('markRead'); },
    async markUnread() { stores.push('markUnread'); }
  };

  await syncAccount({ accountId: 'a', provider, store, mode: 'incremental', batchSize: 50 });

  const mirrored = store.getMessage('a:inbox:42:7');
  assert.deepEqual(mirrored.flags, ['\\Flagged']);
  assert.equal(mirrored.raw, 'KEEP-SEEN');
  assert.deepEqual(store.getMessage('other:inbox:42:7').flags, ['\\Seen']);
  assert.equal(store.getMessage('other:inbox:42:7').raw, 'OTHER');
  assert.deepEqual(flagFetches, [{ path: 'INBOX', uids: [7], uidValidity: '42' }]);
  assert.equal(bodyFetches.length, 0);
  assert.equal(stores.length, 0);
  closeStore(store, dir);
});

test('incremental sync removes \\Seen when the provider cleared it and keeps new-message body fetch separate', async () => {
  const { dir, store } = openStore();
  await seedMessage(store, { uid: 1, flags: ['\\Seen'], raw: 'OLD-BODY' });
  await store.checkpoint({
    accountId: 'a',
    mailboxId: 'inbox',
    mode: 'incremental',
    lastUid: 1,
    uidValidity: '42',
    uidNext: 2,
    remoteMessages: 1,
    localMessageCount: 1,
    status: 'syncing',
    messageCount: 1
  });
  const bodyQueries = [];
  const flagQueries = [];
  const provider = {
    async listMailboxes() {
      return [{ id: 'inbox', path: 'INBOX', messages: 2, uidNext: 3, uidValidity: '42' }];
    },
    async *fetchMessages(_mailbox, options) {
      bodyQueries.push(options.uids ?? options.checkpoint);
      yield { uid: 2, uidValidity: '42', raw: 'NEW-BODY', flags: [], attachments: [] };
    },
    async *fetchFlags(_mailbox, options) {
      flagQueries.push([...options.uids]);
      for (const uid of options.uids) {
        yield { uid, uidValidity: options.uidValidity, flags: uid === 1 ? [] : ['\\Seen'] };
      }
    },
    async markRead() { throw new Error('store_not_allowed'); },
    async markUnread() { throw new Error('store_not_allowed'); }
  };

  await syncAccount({ accountId: 'a', provider, store, mode: 'incremental', batchSize: 2 });

  assert.equal(store.getMessage('a:inbox:42:1').raw, 'OLD-BODY');
  assert.deepEqual(store.getMessage('a:inbox:42:1').flags, []);
  assert.equal(store.getMessage('a:inbox:42:2').raw, 'NEW-BODY');
  assert.deepEqual(store.getMessage('a:inbox:42:2').flags, ['\\Seen']);
  assert.equal(bodyQueries.some((query) => Array.isArray(query) && query.includes(1)), false);
  assert.ok(flagQueries.some((uids) => uids.includes(1)));
  assert.ok(flagQueries.every((uids) => uids.length <= 2));
  closeStore(store, dir);
});

test('flag reconciliation ignores a UIDVALIDITY mismatch and does not run during full sync', async () => {
  const { dir, store } = openStore();
  await seedMessage(store, { flags: ['\\Seen'], raw: 'STABLE' });
  await store.checkpoint({
    accountId: 'a',
    mailboxId: 'inbox',
    mode: 'incremental',
    lastUid: 7,
    uidValidity: '42',
    uidNext: 8,
    remoteMessages: 1,
    localMessageCount: 1,
    status: 'completed',
    messageCount: 1
  });
  let fetches = 0;
  const mismatchProvider = {
    async listMailboxes() {
      return [{ id: 'inbox', path: 'INBOX', messages: 1, uidNext: 8, uidValidity: '42' }];
    },
    async *fetchFlags() {
      fetches += 1;
      throw new Error('identity_mismatch');
    },
    async *fetchMessages() { throw new Error('body_not_allowed'); }
  };
  await syncAccount({ accountId: 'a', provider: mismatchProvider, store, mode: 'incremental' });
  assert.equal(fetches, 1);
  assert.deepEqual(store.getMessage('a:inbox:42:7').flags, ['\\Seen']);
  assert.equal(store.getMessage('a:inbox:42:7').raw, 'STABLE');

  let fullFetches = 0;
  const fullProvider = {
    async listMailboxes() {
      return [{ id: 'inbox', path: 'INBOX', messages: 1, uidNext: 8, uidValidity: '42' }];
    },
    async *fetchFlags() { fullFetches += 1; },
    async *fetchMessages() {}
  };
  await syncAccount({ accountId: 'a', provider: fullProvider, store, mode: 'full' });
  assert.equal(fullFetches, 0);
  assert.deepEqual(store.getMessage('a:inbox:42:7').flags, ['\\Seen']);
  closeStore(store, dir);
});

test('updateMessageFlags replaces flags for the exact identity and leaves raw MIME untouched', async () => {
  const { dir, store } = openStore();
  await seedMessage(store, { flags: ['\\Seen'], raw: 'BODY' });
  await seedMessage(store, {
    accountId: 'other',
    mailboxId: 'inbox',
    uid: 7,
    uidValidity: '42',
    flags: ['\\Seen'],
    raw: 'OTHER-BODY',
    key: 'other:inbox:42:7'
  });
  const updated = await store.updateMessageFlags({
    accountId: 'a',
    mailboxId: 'inbox',
    uid: 7,
    uidValidity: '42',
    flags: []
  });
  assert.equal(updated, true);
  assert.deepEqual(store.getMessage('a:inbox:42:7').flags, []);
  assert.equal(store.getMessage('a:inbox:42:7').raw, 'BODY');
  assert.deepEqual(store.getMessage('other:inbox:42:7').flags, ['\\Seen']);
  const wrongValidity = await store.updateMessageFlags({
    accountId: 'a',
    mailboxId: 'inbox',
    uid: 7,
    uidValidity: '99',
    flags: ['\\Seen']
  });
  assert.equal(wrongValidity, false);
  assert.deepEqual(store.getMessage('a:inbox:42:7').flags, []);
  closeStore(store, dir);
});
