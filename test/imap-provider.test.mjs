import test from 'node:test';
import assert from 'node:assert/strict';
import { boundedUidRange, ImapProvider } from '../src/mail/imap-provider.mjs';

test('boundedUidRange caps each batch at batchSize UIDs below uidNext', () => {
  assert.deepEqual(boundedUidRange(1, 100, 74_001), { startUid: 1, endUid: 100 });
  assert.deepEqual(boundedUidRange(100, 100, 74_001), { startUid: 100, endUid: 199 });
  assert.deepEqual(boundedUidRange(73_950, 100, 74_001), { startUid: 73_950, endUid: 74_000 });
});

test('boundedUidRange returns null when there is nothing left to fetch', () => {
  assert.equal(boundedUidRange(74_001, 100, 74_001), null);
  assert.equal(boundedUidRange(10, 100, null), null);
});

test('fetchMessages issues a bounded UID FETCH range for the first batch promptly', async () => {
  let fetchQuery;
  const provider = new ImapProvider({
    connection: { host: 'imap.example', port: 993 },
    credentials: { username: 'u', password: 'p' }
  });
  provider.client = {
    connect: async () => {},
    getMailboxLock: async () => ({ release: () => {} }),
    status: async () => ({ messages: 50_000, uidValidity: 42, uidNext: 74_001 }),
    fetch: (query, _opts, _fetchOpts) => {
      fetchQuery = query;
      return (async function* () {
        yield { uid: 1, flags: [], internalDate: new Date(), envelope: null, source: Buffer.from('a') };
      })();
    },
    logout: async () => {},
    close: async () => {}
  };
  provider.connected = true;

  const mailbox = { id: 'INBOX', path: 'INBOX' };
  const messages = [];
  for await (const message of provider.fetchMessages(mailbox, { batchSize: 100 })) {
    messages.push(message);
  }

  assert.equal(fetchQuery, '1:100');
  assert.equal(messages.length, 1);
});

test('fetchMessages resumes from checkpoint with a bounded range', async () => {
  let fetchQuery;
  const provider = new ImapProvider({
    connection: { host: 'imap.example', port: 993 },
    credentials: { username: 'u', password: 'p' }
  });
  provider.client = {
    connect: async () => {},
    getMailboxLock: async () => ({ release: () => {} }),
    status: async () => ({ messages: 10, uidValidity: 99, uidNext: 11 }),
    fetch: (query) => {
      fetchQuery = query;
      return (async function* () {})();
    },
    logout: async () => {},
    close: async () => {}
  };
  provider.connected = true;

  const mailbox = { id: 'INBOX', path: 'INBOX' };
  for await (const _message of provider.fetchMessages(mailbox, {
    batchSize: 3,
    checkpoint: { lastUid: 4, uidValidity: '99' }
  })) {
    // no messages in empty iterator
  }

  assert.equal(fetchQuery, '5:7');
});
