import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as z from 'zod/v4';
import { SqliteMailStore } from '../src/storage/sqlite-store.mjs';
import { createPrincipalRegistry } from '../src/security/principal-scope.mjs';
import { createMessageSearchHandler, messageSearchDescription, messageSearchInputSchema } from '../src/mcp/message-search-tools.mjs';

const ACCOUNT = {
  id: 'gmail',
  email: 'mert@example.test',
  provider: 'gmail',
  secretRef: 'resource-gmail',
  connection: { host: 'imap.gmail.com' }
};

/**
 * Open a temporary mail store.
 * @returns {{ store: SqliteMailStore, close: Function }}
 */
function openStore() {
  const dir = mkdtempSync(join(tmpdir(), 'agentmail-msg-search-'));
  const store = new SqliteMailStore(join(dir, 'mail.db'));
  return {
    store,
    close() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

/**
 * Insert one mirrored message.
 * @param {SqliteMailStore} store
 * @param {object} message
 */
async function putMessage(store, message) {
  await store.upsertMessage({
    accountId: 'info',
    mailboxId: 'inbox',
    uidValidity: 'v1',
    flags: [],
    attachments: [],
    envelope: {},
    raw: '',
    ...message
  });
}

test('positional message_search still returns a message array', async () => {
  const { store, close } = openStore();
  try {
    await putMessage(store, {
      key: 'info:inbox:v1:1',
      uid: 1,
      internalDate: '2024-05-01T00:00:00.000Z',
      raw: 'Subject: Project\n\nKubernetes offer',
      envelope: { subject: 'Project offer', from: [{ address: 'a@example.test' }] }
    });
    const rows = store.searchMessages('info', 'kubernetes', 10);
    assert.ok(Array.isArray(rows));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].key, 'info:inbox:v1:1');
    assert.equal(rows[0].envelope.subject, 'Project offer');
  } finally {
    close();
  }
});

test('listMessages stays an array filtered by mailbox', async () => {
  const { store, close } = openStore();
  try {
    await putMessage(store, { key: 'info:inbox:v1:1', uid: 1, mailboxId: 'inbox', internalDate: '2024-05-02T00:00:00.000Z', raw: 'inbox' });
    await putMessage(store, { key: 'info:sent:v1:2', uid: 2, mailboxId: 'sent', internalDate: '2024-05-03T00:00:00.000Z', raw: 'sent' });
    const listed = store.listMessages('info', 'inbox', 10);
    assert.ok(Array.isArray(listed));
    assert.equal(listed.length, 1);
    assert.equal(listed[0].mailboxId, 'inbox');
    assert.equal(listed.items, undefined);
  } finally {
    close();
  }
});

test('criteria search returns an envelope with items, cursor, filters, and total', async () => {
  const { store, close } = openStore();
  try {
    await putMessage(store, {
      key: 'info:inbox:v1:1',
      uid: 1,
      internalDate: '2024-05-01T00:00:00.000Z',
      raw: 'Kubernetes offer',
      envelope: { subject: 'Project offer' }
    });
    const page = store.searchMessages({ accountId: 'info', query: 'kubernetes', limit: 10 });
    assert.equal(page.total, 1);
    assert.equal(page.hasMore, false);
    assert.equal(page.nextCursor, null);
    assert.deepEqual(page.results, page.items);
    assert.equal(page.items[0].key, 'info:inbox:v1:1');
    assert.equal(page.appliedFilters.query, 'kubernetes');
    assert.equal(page.appliedFilters.limit, 10);
    assert.equal(page.appliedFilters.sortBy, 'date');
    assert.equal(page.appliedFilters.sortOrder, 'desc');
  } finally {
    close();
  }
});

test('full-text matches body and field filters stay on their envelope fields', async () => {
  const { store, close } = openStore();
  try {
    await putMessage(store, {
      key: 'info:inbox:v1:1',
      uid: 1,
      internalDate: '2024-04-01T00:00:00.000Z',
      raw: 'Body mentions uniquebodytoken only',
      envelope: {
        subject: 'Hello',
        from: [{ name: 'Alice', address: 'alice@example.test' }],
        to: [{ address: 'bob@example.test' }],
        cc: [{ address: 'cara@example.test' }]
      }
    });
    await putMessage(store, {
      key: 'info:inbox:v1:2',
      uid: 2,
      internalDate: '2024-04-02T00:00:00.000Z',
      raw: 'nothing',
      envelope: { subject: 'Invoice 100% done', from: [{ address: 'other@example.test' }], to: [], cc: [] }
    });
    assert.equal(store.searchMessages({ accountId: 'info', query: 'uniquebodytoken' }).total, 1);
    assert.equal(store.searchMessages({ accountId: 'info', query: '100%' }).items[0].key, 'info:inbox:v1:2');
    assert.equal(store.searchMessages({ accountId: 'info', query: '_' }).total, 0);
    assert.equal(store.searchMessages({ accountId: 'info', subject: 'invoice' }).items[0].key, 'info:inbox:v1:2');
    assert.equal(store.searchMessages({ accountId: 'info', subject: 'uniquebodytoken' }).total, 0);
    assert.equal(store.searchMessages({ accountId: 'info', from: 'alice' }).items[0].key, 'info:inbox:v1:1');
    assert.equal(store.searchMessages({ accountId: 'info', from: 'bob@example.test' }).total, 0);
    assert.equal(store.searchMessages({ accountId: 'info', to: 'bob@' }).items[0].key, 'info:inbox:v1:1');
    assert.equal(store.searchMessages({ accountId: 'info', cc: 'cara@' }).items[0].key, 'info:inbox:v1:1');
    assert.equal(store.searchMessages({ accountId: 'info', to: 'cara@' }).total, 0);
  } finally {
    close();
  }
});

test('mailbox, UTC date, read, attachment, and flag filters combine', async () => {
  const { store, close } = openStore();
  try {
    await putMessage(store, {
      key: 'info:inbox:v1:1',
      uid: 1,
      mailboxId: 'inbox',
      internalDate: '2024-03-10T00:00:00.000Z',
      flags: ['\\Seen', '\\Flagged'],
      attachments: [{ filename: 'note.txt' }],
      envelope: { subject: 'Kept' }
    });
    await putMessage(store, {
      key: 'info:inbox:v1:2',
      uid: 2,
      mailboxId: 'inbox',
      internalDate: '2024-03-09T23:00:00.000Z',
      flags: ['\\Seen'],
      envelope: { subject: 'Too early' }
    });
    await putMessage(store, {
      key: 'info:sent:v1:3',
      uid: 3,
      mailboxId: 'sent',
      internalDate: '2024-03-10T12:00:00.000Z',
      flags: [],
      raw: 'Content-Disposition: attachment; filename="x.bin"\n\nblob',
      envelope: { subject: 'Mime attach' }
    });
    await putMessage(store, {
      key: 'info:archive:v1:4',
      uid: 4,
      mailboxId: 'archive',
      internalDate: '2024-03-11T00:00:00.000Z',
      flags: ['\\Flagged'],
      envelope: { subject: 'Unread flagged' }
    });

    const matched = store.searchMessages({
      accountId: 'info',
      mailboxIds: ['inbox', 'archive'],
      since: '2024-03-10',
      before: '2024-03-11T00:00:00+00:00',
      isRead: true,
      hasAttachment: true,
      flags: ['\\Flagged']
    });
    assert.deepEqual(matched.items.map((item) => item.key), ['info:inbox:v1:1']);
    assert.equal(matched.appliedFilters.since, '2024-03-10T00:00:00.000Z');
    assert.equal(matched.appliedFilters.before, '2024-03-11T00:00:00.000Z');
    assert.deepEqual(matched.appliedFilters.mailboxIds, ['archive', 'inbox']);

    const unread = store.searchMessages({ accountId: 'info', isUnread: true, includeFlags: ['\\Flagged'] });
    assert.deepEqual(unread.items.map((item) => item.key), ['info:archive:v1:4']);

    const mimeAttachment = store.searchMessages({ accountId: 'info', mailboxId: 'sent', hasAttachment: true });
    assert.deepEqual(mimeAttachment.items.map((item) => item.key), ['info:sent:v1:3']);

    const offsetSince = store.searchMessages({ accountId: 'info', fromDate: '2024-03-10T01:00:00+01:00', mailboxId: 'inbox' });
    assert.deepEqual(offsetSince.items.map((item) => item.key), ['info:inbox:v1:1']);
  } finally {
    close();
  }
});

test('cursor pages are stable across equal dates and do not skip or repeat', async () => {
  const { store, close } = openStore();
  try {
    const stamps = ['2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z', '2024-01-02T00:00:00.000Z', '2024-01-02T00:00:00.000Z', '2024-01-03T00:00:00.000Z'];
    for (let index = 0; index < stamps.length; index += 1) {
      await putMessage(store, {
        key: `info:inbox:v1:${index + 1}`,
        uid: index + 1,
        internalDate: stamps[index],
        raw: `row-${index + 1}`
      });
    }
    const seen = [];
    let cursor;
    let pages = 0;
    do {
      const page = store.searchMessages({ accountId: 'info', limit: 2, cursor, sortBy: 'date', sortOrder: 'desc' });
      pages += 1;
      seen.push(...page.items.map((item) => item.key));
      assert.equal(page.total, 5);
      assert.equal(page.hasMore, Boolean(page.nextCursor));
      cursor = page.nextCursor;
    } while (cursor);
    assert.equal(pages, 3);
    assert.deepEqual(seen, [
      'info:inbox:v1:5',
      'info:inbox:v1:4',
      'info:inbox:v1:3',
      'info:inbox:v1:2',
      'info:inbox:v1:1'
    ]);
  } finally {
    close();
  }
});

test('sortBy uid honors asc and desc without duplicates', async () => {
  const { store, close } = openStore();
  try {
    await putMessage(store, { key: 'info:inbox:v1:a', uid: 30, mailboxId: 'inbox', internalDate: '2024-01-01T00:00:00.000Z' });
    await putMessage(store, { key: 'info:sent:v1:b', uid: 10, mailboxId: 'sent', internalDate: '2024-08-01T00:00:00.000Z' });
    await putMessage(store, { key: 'info:inbox:v1:c', uid: 20, mailboxId: 'inbox', internalDate: '2024-02-01T00:00:00.000Z' });
    const asc = store.searchMessages({ accountId: 'info', sortBy: 'uid', sortOrder: 'asc', limit: 2 });
    assert.deepEqual(asc.items.map((item) => item.uid), [10, 20]);
    const next = store.searchMessages({ accountId: 'info', sortBy: 'uid', sortOrder: 'asc', limit: 2, cursor: asc.nextCursor });
    assert.deepEqual(next.items.map((item) => item.uid), [30]);
    assert.equal(next.hasMore, false);
    const desc = store.searchMessages({ accountId: 'info', sortBy: 'uid', sortOrder: 'desc', limit: 10 });
    assert.deepEqual(desc.items.map((item) => item.uid), [30, 20, 10]);
  } finally {
    close();
  }
});

test('invalid dates, limits, cursors, and status combinations are rejected', async () => {
  const { store, close } = openStore();
  try {
    await putMessage(store, { key: 'info:inbox:v1:1', uid: 1, internalDate: '2024-01-01T00:00:00.000Z', raw: 'kept' });
    assert.throws(() => store.searchMessages({ accountId: 'info', since: '2024-13-01' }), /invalid_date/);
    assert.throws(() => store.searchMessages({ accountId: 'info', before: '15/01/2024' }), /invalid_date/);
    assert.throws(() => store.searchMessages({ accountId: 'info', fromDate: '2024-01-01', since: '2024-02-01' }), /invalid_date/);
    assert.throws(() => store.searchMessages({ accountId: 'info', limit: 0 }), /invalid_limit/);
    assert.throws(() => store.searchMessages({ accountId: 'info', limit: 201 }), /invalid_limit/);
    assert.throws(() => store.searchMessages({ accountId: 'info', limit: 1.5 }), /invalid_limit/);
    assert.throws(() => store.searchMessages({ accountId: 'info', cursor: 'not-a-cursor' }), /invalid_cursor/);
    assert.throws(() => store.searchMessages({ accountId: 'info', sortBy: 'relevance' }), /invalid_sort/);
    assert.throws(() => store.searchMessages({ accountId: 'info', isRead: true, isUnread: true }), /invalid_status_filter/);
    await putMessage(store, { key: 'info:inbox:v1:2', uid: 2, internalDate: '2024-01-02T00:00:00.000Z', raw: 'kept-2' });
    const page = store.searchMessages({ accountId: 'info', sortBy: 'date', sortOrder: 'desc', limit: 1 });
    assert.equal(typeof page.nextCursor, 'string');
    assert.throws(() => store.searchMessages({ accountId: 'info', sortBy: 'uid', sortOrder: 'desc', cursor: page.nextCursor }), /invalid_cursor/);
    assert.equal(store.countMessages('info'), 2);
  } finally {
    close();
  }
});

test('search parameters cannot inject SQL and corrupt JSON does not throw', async () => {
  const { store, close } = openStore();
  try {
    await putMessage(store, {
      key: 'info:inbox:v1:1',
      uid: 1,
      internalDate: '2024-01-01T00:00:00.000Z',
      raw: 'FindMe please',
      envelope: { subject: 'Safe' }
    });
    const page = store.searchMessages({
      accountId: 'info',
      query: "' OR 1=1; DROP TABLE messages; --",
      subject: "x' UNION SELECT message_key FROM messages --",
      mailboxId: "inbox' OR '1'='1",
      sql: 'DROP TABLE messages',
      where: '1=1 OR account_id IS NOT NULL'
    });
    assert.equal(page.total, 0);
    assert.equal(store.countMessages('info'), 1);
    store.db.prepare('UPDATE messages SET envelope_json = ?, flags_json = ?, attachments_json = ? WHERE message_key = ?')
      .run('{bad', '{bad', '{bad', 'info:inbox:v1:1');
    const recovered = store.searchMessages({ accountId: 'info', query: 'FindMe' });
    assert.equal(recovered.total, 1);
    assert.equal(recovered.items[0].envelope, null);
    assert.deepEqual(recovered.items[0].flags, []);
    assert.equal(store.searchMessages({ accountId: 'info', query: 'FindMe', flags: ['\\Seen'] }).total, 0);
    assert.doesNotThrow(() => store.searchMessages({ accountId: 'info', hasAttachment: false }));
  } finally {
    close();
  }
});

test('search stays inside the requested account and the caller principal', async () => {
  const { store, close } = openStore();
  try {
    await putMessage(store, {
      accountId: 'gmail',
      key: 'gmail:inbox:v1:1',
      uid: 1,
      raw: 'secret-body',
      envelope: { subject: 'Secret' }
    });
    await putMessage(store, {
      accountId: 'other',
      key: 'other:inbox:v1:1',
      uid: 1,
      raw: 'secret-body',
      envelope: { subject: 'Secret' }
    });
    const page = store.searchMessages({ accountId: 'gmail', query: 'secret' });
    assert.deepEqual(page.items.map((item) => item.accountId), ['gmail']);
    store.activateAccountLegacy(ACCOUNT);
    const mert = createPrincipalRegistry(store, 'mert');
    let remoteCalls = 0;
    const mailService = {
      async searchRemote(criteria) {
        remoteCalls += 1;
        assert.equal(criteria.accountId, 'gmail');
        return {
          items: [{ accountId: 'gmail', key: 'gmail:INBOX:1:1' }],
          results: [{ accountId: 'gmail', key: 'gmail:INBOX:1:1' }],
          total: 1,
          hasMore: false,
          nextCursor: null,
          appliedFilters: {}
        };
      }
    };
    const handler = createMessageSearchHandler({ mailService, registry: mert });
    const denied = JSON.parse((await handler({ accountId: 'gmail', query: 'secret' })).content[0].text);
    assert.equal(denied.error, 'access_denied');
    assert.equal(denied.items, undefined);
    assert.equal(remoteCalls, 0);
    mert.register(ACCOUNT);
    const allowed = JSON.parse((await handler({ accountId: 'gmail', query: 'secret' })).content[0].text);
    assert.equal(allowed.total, 1);
    assert.equal(allowed.items[0].accountId, 'gmail');
    assert.equal(remoteCalls, 1);
    const other = createPrincipalRegistry(store, 'other-user');
    const foreign = JSON.parse((await createMessageSearchHandler({ mailService, registry: other })({ accountId: 'gmail', query: 'secret' })).content[0].text);
    assert.equal(foreign.error, 'access_denied');
    assert.equal(remoteCalls, 1);
  } finally {
    close();
  }
});

test('MCP message_search schema keeps the original arguments and describes the envelope', () => {
  assert.match(messageSearchDescription, /nextCursor/);
  assert.match(messageSearchDescription, /ISO-8601/);
  assert.match(messageSearchDescription, /IMAP TEXT/);
  assert.match(messageSearchDescription, /allMailboxes/);
  assert.match(messageSearchDescription, /only INBOX/);
  const schema = z.object(messageSearchInputSchema);
  const parsed = schema.parse({ accountId: 'info' });
  assert.equal(parsed.query, '');
  assert.equal(parsed.limit, 50);
  assert.equal(parsed.sortBy, 'date');
  assert.equal(parsed.sortOrder, 'desc');
  assert.equal('subject' in messageSearchInputSchema, true);
  assert.equal('cursor' in messageSearchInputSchema, true);
  assert.equal('mailboxIds' in messageSearchInputSchema, true);
  assert.equal('hasAttachment' in messageSearchInputSchema, true);
  assert.throws(() => schema.parse({ accountId: 'info', limit: 500 }), /limit/);
  assert.throws(() => schema.parse({ accountId: 'info', sortBy: 'raw' }), /sortBy/);
});

test('MCP handler maps invalid search input to a safe error code', async () => {
  const { store, close } = openStore();
  try {
    store.activateAccountForPrincipal(ACCOUNT, 'mert');
    const handler = createMessageSearchHandler({
      mailService: { async searchRemote() { throw new Error('store_fallback'); } },
      registry: createPrincipalRegistry(store, 'mert')
    });
    const invalid = JSON.parse((await handler({ accountId: 'gmail', since: 'yesterday' })).content[0].text);
    assert.equal(invalid.error, 'invalid_date');
    assert.equal(JSON.stringify(invalid).includes('SELECT'), false);
  } finally {
    close();
  }
});
