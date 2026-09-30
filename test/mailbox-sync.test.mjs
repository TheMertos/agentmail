import test from 'node:test';
import assert from 'node:assert/strict';
import { isSelectableMailbox, isMailboxSyncComplete } from '../src/mail/mailbox-sync.mjs';

test('isSelectableMailbox rejects IMAP Noselect mailboxes', () => {
  assert.equal(isSelectableMailbox({ path: '[Google Mail]', flags: ['\\Noselect'] }), false);
  assert.equal(isSelectableMailbox({ path: 'INBOX', flags: [] }), true);
});

test('isMailboxSyncComplete requires lastUid at uidNext-1 when uidNext is reliable', () => {
  assert.equal(isMailboxSyncComplete({ lastUid: 6010, uidNext: 77_269 }), false);
  assert.equal(isMailboxSyncComplete({ lastUid: 77_268, uidNext: 77_269 }), true);
});

test('isMailboxSyncComplete Gmail regression: uid caught up but local count below remote', () => {
  assert.equal(
    isMailboxSyncComplete({
      lastUid: 108_245,
      uidNext: 108_245,
      remoteMessages: 77_268,
      localMessageCount: 6010
    }),
    false
  );
});

test('isMailboxSyncComplete requires both uid and count when both signals exist', () => {
  assert.equal(
    isMailboxSyncComplete({
      lastUid: 77_268,
      uidNext: 77_269,
      remoteMessages: 77_268,
      localMessageCount: 77_268
    }),
    true
  );
  assert.equal(
    isMailboxSyncComplete({
      lastUid: 77_268,
      uidNext: 77_269,
      remoteMessages: 77_268,
      localMessageCount: 6010
    }),
    false
  );
  assert.equal(
    isMailboxSyncComplete({
      lastUid: 6010,
      uidNext: 77_269,
      remoteMessages: 77_268,
      localMessageCount: 77_268
    }),
    false
  );
});

test('isMailboxSyncComplete sparse UIDs: lastUid at uidNext-1 does not complete without full local count', () => {
  assert.equal(
    isMailboxSyncComplete({
      lastUid: 99_999,
      uidNext: 100_000,
      remoteMessages: 500,
      localMessageCount: 120
    }),
    false
  );
  assert.equal(
    isMailboxSyncComplete({
      lastUid: 99_999,
      uidNext: 100_000,
      remoteMessages: 500,
      localMessageCount: 500
    }),
    true
  );
});

test('isMailboxSyncComplete uses count-only when uidNext is missing', () => {
  assert.equal(
    isMailboxSyncComplete({ lastUid: 3, remoteMessages: 10, localMessageCount: 10 }),
    true
  );
  assert.equal(
    isMailboxSyncComplete({ lastUid: 3, remoteMessages: 10, localMessageCount: 9 }),
    false
  );
});
