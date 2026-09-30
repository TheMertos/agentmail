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
