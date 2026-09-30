import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncAccount } from '../src/mail/sync-engine.mjs';
import { accountSyncProgress } from '../src/mail/sync-progress.mjs';
import { buildSyncStatus } from '../src/mail/sync-status.mjs';
import { SqliteMailStore } from '../src/storage/sqlite-store.mjs';
import { activateTestAccount } from './test-principal.mjs';

const GMAIL_ALL_MAIL = '[Google Mail]/Alle Nachrichten';
const GMAIL_PARENT = '[Google Mail]';
const REMOTE_COUNT = 77_268;
const UID_NEXT = 77_269;
const BATCH_SIZE = 100;

function memoryStore() {
  const messages = new Map();
  const checkpoints = new Map();
  return {
    async upsertFolder() {},
    async upsertMessage(message) {
      messages.set(message.key, message);
    },
    async getCheckpoint(accountId, mailboxId) {
      return checkpoints.get(`${accountId}:${mailboxId}`) ?? null;
    },
    async checkpoint(data) {
      const key = `${data.accountId}:${data.mailboxId}`;
      checkpoints.set(key, { ...data, updatedAt: data.updatedAt ?? new Date().toISOString() });
    },
    countMessagesInMailbox(accountId, mailboxId) {
      return [...messages.values()].filter((m) => m.accountId === accountId && m.mailboxId === mailboxId).length;
    }
  };
}

test('Gmail Alle Nachrichten stays syncing after one bounded batch below uidNext', async () => {
  const store = memoryStore();
  let fetchInvocations = 0;
  const provider = {
    async listMailboxes() {
      return [{
        id: GMAIL_ALL_MAIL,
        path: GMAIL_ALL_MAIL,
        messages: REMOTE_COUNT,
        uidNext: UID_NEXT,
        uidValidity: '42',
        flags: []
      }];
    },
    async *fetchMessages(_mailbox, { checkpoint, batchSize = BATCH_SIZE }) {
      fetchInvocations += 1;
      const start = (checkpoint?.lastUid ?? 0) + 1;
      const end = Math.min(start + batchSize - 1, UID_NEXT - 1);
      if (start > end || fetchInvocations > 1) return;
      for (let uid = start; uid <= end; uid += 1) {
        yield {
          uid,
          uidValidity: '42',
          folderId: GMAIL_ALL_MAIL,
          raw: `m${uid}`,
          flags: [],
          attachments: []
        };
      }
    }
  };

  await syncAccount({
    accountId: 'gmail',
    provider,
    store,
    mode: 'full',
    batchSize: BATCH_SIZE
  });

  const cp = await store.getCheckpoint('gmail', GMAIL_ALL_MAIL);
  assert.equal(cp.lastUid, 100);
  assert.equal(cp.status, 'syncing');
  assert.notEqual(cp.status, 'completed');
  assert.equal(store.countMessagesInMailbox('gmail', GMAIL_ALL_MAIL), 100);
});

test('sync skips non-selectable Gmail parent and does not checkpoint it', async () => {
  const store = memoryStore();
  const provider = {
    async listMailboxes() {
      return [
        { id: GMAIL_PARENT, path: GMAIL_PARENT, flags: ['\\Noselect'], messages: null, uidNext: null, uidValidity: null },
        {
          id: GMAIL_ALL_MAIL,
          path: GMAIL_ALL_MAIL,
          messages: REMOTE_COUNT,
          uidNext: UID_NEXT,
          uidValidity: '42',
          flags: []
        }
      ];
    },
    async *fetchMessages(mailbox) {
      if (mailbox.id !== GMAIL_ALL_MAIL) return;
      yield { uid: 1, uidValidity: '42', folderId: GMAIL_ALL_MAIL, raw: 'm1', flags: [], attachments: [] };
    }
  };

  await syncAccount({ accountId: 'gmail', provider, store, mode: 'full', batchSize: BATCH_SIZE });
  assert.equal(await store.getCheckpoint('gmail', GMAIL_PARENT), null);
});

test('account percentage ignores Noselect parent with null remote total', () => {
  const progress = accountSyncProgress([
    {
      folderId: GMAIL_PARENT,
      remoteMessages: null,
      localCount: 0,
      selectable: false
    },
    {
      folderId: GMAIL_ALL_MAIL,
      remoteMessages: REMOTE_COUNT,
      localCount: 6010,
      selectable: true
    }
  ]);
  assert.equal(progress.remoteCount, REMOTE_COUNT);
  assert.equal(progress.downloadedCount, 6010);
  assert.equal(progress.remaining, 71_258);
  assert.equal(progress.percentage, 8);
});

test('buildSyncStatus Gmail regression: partial folder not completed, account percent from selectable only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentmail-gmail-regression-'));
  const store = new SqliteMailStore(join(dir, 'mail.db'));
  activateTestAccount(store, { id: 'gmail', email: 'u@gmail.com', provider: 'imap', secretRef: 'ref' });
  store.upsertFolder({ accountId: 'gmail', id: GMAIL_PARENT, path: GMAIL_PARENT, flags: ['\\Noselect'] });
  store.upsertFolder({ accountId: 'gmail', id: GMAIL_ALL_MAIL, path: GMAIL_ALL_MAIL, flags: [] });
  store.checkpoint({
    accountId: 'gmail',
    mailboxId: GMAIL_PARENT,
    mode: 'full',
    lastUid: 0,
    uidValidity: null,
    remoteMessages: null,
    uidNext: null,
    localMessageCount: 0,
    status: 'syncing',
    messageCount: 0
  });
  store.checkpoint({
    accountId: 'gmail',
    mailboxId: GMAIL_ALL_MAIL,
    mode: 'full',
    lastUid: 6010,
    uidValidity: '42',
    remoteMessages: REMOTE_COUNT,
    uidNext: UID_NEXT,
    localMessageCount: 6010,
    status: 'syncing',
    messageCount: 6010
  });

  const status = buildSyncStatus(store, 'gmail');
  const allMail = status.folders.find((f) => f.folderId === GMAIL_ALL_MAIL);
  assert.equal(allMail.state, 'syncing');
  assert.equal(allMail.remoteCount, REMOTE_COUNT);
  assert.equal(allMail.localCount, 6010);
  assert.equal(allMail.remaining, 71_258);
  assert.equal(status.percentage, 8);
  assert.equal(status.remoteCount, REMOTE_COUNT);

  store.close();
  rmSync(dir, { recursive: true, force: true });
});
