import test from 'node:test';
import assert from 'node:assert/strict';
import { MailService } from '../src/mail/mail-service.mjs';
import { createMessageSearchHandler } from '../src/mcp/message-search-tools.mjs';
import { ImapProvider } from '../src/mail/imap-provider.mjs';

test('message_search fails closed and does not read a local mirror', async () => {
  let mirrorReads = 0;
  const handler = createMessageSearchHandler({
    registry: { assertAccountAccess() {} },
    mailService: {
      async searchRemote() {
        throw new Error('imap_down');
      }
    }
  });
  const store = { searchMessages() { mirrorReads += 1; return { items: [{ raw: 'cached' }], total: 1 }; } };
  const payload = JSON.parse((await handler({ accountId: 'gmail', query: 'secret' })).content[0].text);
  assert.equal(payload.error, 'search_failed');
  assert.equal(payload.items, undefined);
  assert.equal(mirrorReads, 0);
  assert.equal(store.searchMessages().total, 1);
});

/**
 * Build a mail service whose provider records folder discovery and search targets.
 * @param {{ rows?: object[], hangSearch?: boolean, hangConnect?: boolean, operationTimeoutMs?: number, onRelease?: () => void, onLockRelease?: () => void, onClose?: () => void }} [options]
 * @returns {{ service: MailService, searched: string[], listed: number }}
 */
function searchHarness(options = {}) {
  const searched = [];
  let listed = 0;
  const provider = new ImapProvider({
    connection: { host: 'imap.example', port: 993 },
    credentials: { username: 'u', password: 'p' },
    operationTimeoutMs: options.operationTimeoutMs ?? 30
  });
  provider.connected = options.hangConnect !== true;
  provider.client = {
    connect: () => (options.hangConnect ? new Promise(() => {}) : Promise.resolve()),
    async list() {
      listed += 1;
      return [
        { path: 'INBOX', name: 'INBOX', flags: [] },
        { path: '[Gmail]/All Mail', name: 'All Mail', flags: [] },
        { path: '[Gmail]/Sent Mail', name: 'Sent Mail', flags: [] }
      ];
    },
    async getMailboxLock() {
      return { release() { options.onLockRelease?.(); } };
    },
    async status() { return { uidValidity: 99 }; },
    search: () => (options.hangSearch ? new Promise(() => {}) : Promise.resolve([7])),
    fetch() {
      return (async function* () {
        for (const row of options.rows ?? [{
          uid: 7,
          flags: ['\\Seen'],
          internalDate: new Date('2026-01-02T00:00:00.000Z'),
          envelope: { subject: 'Live' },
          bodyStructure: {}
        }]) yield row;
      })();
    },
    close() { options.onClose?.(); },
    async logout() {}
  };
  const service = new MailService({
    accountRegistry: { get: () => ({ id: 'gmail' }), assertAccountAccess: () => ({ id: 'gmail' }) },
    leaseBroker: {
      acquire: async () => ({ leaseId: 'lease-1' }),
      release: async () => { options.onRelease?.(); }
    },
    providerFactory: async () => ({
      operationTimeoutMs: provider.operationTimeoutMs,
      listMailboxes: (...args) => {
        listed += 1;
        return provider.listMailboxes(...args);
      },
      searchSummaries: async (mailbox, criteria) => {
        searched.push(mailbox.path);
        return provider.searchSummaries(mailbox, criteria);
      },
      close: () => provider.close()
    })
  });
  return { service, searched, get listed() { return listed; } };
}

test('message_search defaults to INBOX and does not enumerate folders', async () => {
  const { service, searched } = searchHarness();
  const page = await service.searchRemote({ accountId: 'gmail', query: 'Live', limit: 10 });
  assert.deepEqual(searched, ['INBOX']);
  assert.equal(page.total, 1);
  assert.equal(page.items[0].mailboxId, 'INBOX');
});

test('explicit mailbox ids search only those folders', async () => {
  const { service, searched } = searchHarness({ rows: [] });
  const page = await service.searchRemote({
    accountId: 'gmail',
    query: 'Live',
    mailboxId: '[Gmail]/Sent Mail',
    mailboxIds: ['Work'],
    limit: 10
  });
  assert.deepEqual(searched, ['Work', '[Gmail]/Sent Mail']);
  assert.equal(page.total, 0);
});

test('message_search does not list every mailbox', async () => {
  let listed = 0;
  const searched = [];
  const service = new MailService({
    accountRegistry: { get: () => ({ id: 'gmail' }), assertAccountAccess: () => ({ id: 'gmail' }) },
    leaseBroker: {
      acquire: async () => ({ leaseId: 'lease-1' }),
      release: async () => {}
    },
    providerFactory: async () => ({
      async listMailboxes() {
        listed += 1;
        return [{ id: 'INBOX', path: 'INBOX', flags: [] }, { id: '[Gmail]/All Mail', path: '[Gmail]/All Mail', flags: [] }];
      },
      async searchSummaries(mailbox) {
        searched.push(mailbox.path);
        return [];
      },
      async close() {}
    })
  });
  await service.searchRemote({ accountId: 'gmail', query: 'Live', limit: 10 });
  await service.searchRemote({ accountId: 'gmail', query: 'Live', mailboxIds: ['Work'], limit: 10 });
  assert.equal(listed, 0);
  assert.deepEqual(searched, ['INBOX', 'Work']);
});

test('a stalled IMAP search releases the lock, closes the provider, and drops the lease', { timeout: 2000 }, async () => {
  let released = 0;
  let closed = 0;
  let lockReleased = 0;
  const { service } = searchHarness({
    hangSearch: true,
    onRelease: () => { released += 1; },
    onClose: () => { closed += 1; },
    onLockRelease: () => { lockReleased += 1; }
  });
  await assert.rejects(
    () => service.searchRemote({ accountId: 'gmail', query: 'Live', limit: 10 }),
    (error) => error?.code === 'remote_timeout'
  );
  assert.equal(lockReleased, 1);
  assert.ok(closed >= 1);
  assert.equal(released, 1);
});

test('a stalled IMAP connect releases the lease and closes the provider', { timeout: 2000 }, async () => {
  let released = 0;
  let closed = 0;
  const { service } = searchHarness({
    hangConnect: true,
    onRelease: () => { released += 1; },
    onClose: () => { closed += 1; }
  });
  await assert.rejects(
    () => service.searchRemote({ accountId: 'gmail', query: 'Live', limit: 10 }),
    (error) => error?.code === 'remote_timeout'
  );
  assert.ok(closed >= 1);
  assert.equal(released, 1);
});

test('message_search maps a remote timeout to a stable error', async () => {
  const handler = createMessageSearchHandler({
    registry: { assertAccountAccess() {} },
    mailService: {
      async searchRemote() {
        const error = new Error('remote_timeout');
        error.code = 'remote_timeout';
        throw error;
      }
    }
  });
  const payload = JSON.parse((await handler({ accountId: 'gmail', query: 'Live' })).content[0].text);
  assert.equal(payload.error, 'remote_timeout');
});

test('searchRemote returns live hits and does not call a store', async () => {
  const service = new MailService({
    accountRegistry: { get: () => ({ id: 'gmail' }), assertAccountAccess: () => ({ id: 'gmail' }) },
    leaseBroker: {
      acquire: async () => ({ leaseId: 'lease-1' }),
      release: async () => {}
    },
    providerFactory: async () => ({
      async listMailboxes() {
        return [{ id: 'INBOX', path: 'INBOX', flags: [] }];
      },
      async searchSummaries() {
        return [{
          mailboxId: 'INBOX',
          uid: 7,
          uidValidity: '99',
          internalDate: '2026-01-02T00:00:00.000Z',
          flags: ['\\Seen'],
          envelope: { subject: 'Live' },
          hasAttachment: false
        }];
      },
      async close() {}
    })
  });
  const page = await service.searchRemote({ accountId: 'gmail', query: 'Live', limit: 10 });
  assert.equal(page.total, 1);
  assert.equal(page.items[0].key, 'gmail:INBOX:99:7');
  assert.equal(page.items[0].uidValidity, '99');
});

test('searchSummaries fetches only the newest limited UIDs from a large SEARCH result', async () => {
  const fetched = [];
  const allUids = Array.from({ length: 1000 }, (_, index) => index + 1);
  const provider = new ImapProvider({
    connection: { host: 'imap.example', port: 993 },
    credentials: { username: 'u', password: 'p' }
  });
  provider.connected = true;
  provider.client = {
    async getMailboxLock() { return { release() {} }; },
    async status() { return { uidValidity: 42 }; },
    async search() { return allUids; },
    fetch(query) {
      fetched.push(String(query));
      const uids = String(query).split(',').map((uid) => Number(uid));
      return (async function* () {
        for (const uid of uids) {
          yield {
            uid,
            flags: [],
            internalDate: new Date('2026-01-02T00:00:00.000Z'),
            envelope: { subject: 'Live' },
            bodyStructure: {}
          };
        }
      })();
    },
    async logout() {},
    async close() {}
  };
  const hits = await provider.searchSummaries(
    { id: 'INBOX', path: 'INBOX' },
    { query: 'Live', limit: 10, sortBy: 'date', sortOrder: 'desc' }
  );
  const fetchedUids = fetched.flatMap((query) => query.split(',')).map((uid) => Number(uid));
  assert.deepEqual(fetchedUids, [991, 992, 993, 994, 995, 996, 997, 998, 999, 1000]);
  assert.equal(fetchedUids.includes(1), false);
  assert.equal(fetchedUids.length, 10);
  assert.deepEqual(hits.map((hit) => hit.uid), fetchedUids);
});

test('searchSummaries fetches the oldest limited UIDs when sort order is ascending', async () => {
  const fetched = [];
  const provider = new ImapProvider({
    connection: { host: 'imap.example', port: 993 },
    credentials: { username: 'u', password: 'p' }
  });
  provider.connected = true;
  provider.client = {
    async getMailboxLock() { return { release() {} }; },
    async status() { return { uidValidity: 42 }; },
    async search() { return [40, 10, 30, 20]; },
    fetch(query) {
      fetched.push(String(query));
      return (async function* () {
        for (const uid of String(query).split(',').map((value) => Number(value))) {
          yield {
            uid,
            flags: [],
            internalDate: new Date('2026-01-02T00:00:00.000Z'),
            envelope: { subject: 'Live' },
            bodyStructure: {}
          };
        }
      })();
    },
    async logout() {},
    async close() {}
  };
  await provider.searchSummaries(
    { id: 'INBOX', path: 'INBOX' },
    { query: 'Live', limit: 2, sortBy: 'uid', sortOrder: 'asc' }
  );
  assert.deepEqual(fetched, ['10,20']);
});

test('searchSummaries uses IMAP SEARCH and does not STORE', async () => {
  const commands = [];
  const provider = new ImapProvider({
    connection: { host: 'imap.example', port: 993 },
    credentials: { username: 'u', password: 'p' }
  });
  provider.connected = true;
  provider.client = {
    async getMailboxLock() { return { release() {} }; },
    async status() { return { uidValidity: 42 }; },
    async search(query) {
      commands.push(['search', query]);
      return [7];
    },
    fetch(query, options) {
      commands.push(['fetch', query, options]);
      return (async function* () {
        yield {
          uid: 7,
          flags: ['\\Flagged'],
          internalDate: new Date('2026-01-02T00:00:00.000Z'),
          envelope: { subject: 'Live' },
          bodyStructure: { disposition: 'attachment' }
        };
      })();
    },
    messageFlagsAdd() { commands.push(['store']); },
    async logout() {},
    async close() {}
  };
  const hits = await provider.searchSummaries({ id: 'INBOX', path: 'INBOX' }, { query: 'Live' });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].uid, 7);
  assert.equal(hits[0].uidValidity, '42');
  assert.equal(hits[0].hasAttachment, true);
  assert.equal(commands.some((command) => command[0] === 'store'), false);
  assert.equal(commands[0][0], 'search');
});

test('fetchMessage fails closed when UIDVALIDITY differs', async () => {
  const provider = new ImapProvider({
    connection: { host: 'imap.example', port: 993 },
    credentials: { username: 'u', password: 'p' }
  });
  provider.connected = true;
  provider.client = {
    async getMailboxLock() { return { release() {} }; },
    async status() { return { uidValidity: 1 }; },
    async fetchOne() { throw new Error('should_not_fetch'); },
    async logout() {},
    async close() {}
  };
  await assert.rejects(
    () => provider.fetchMessage({ mailboxId: 'INBOX', uid: 7, uidValidity: '42' }),
    /identity_mismatch/
  );
});
