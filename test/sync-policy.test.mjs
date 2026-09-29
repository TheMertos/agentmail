import test from 'node:test';
import assert from 'node:assert/strict';
import { createSyncPolicy, mailboxIncluded } from '../src/mail/sync-policy.mjs';

test('default policy includes every mailbox', () => {
  const policy = createSyncPolicy({ accountId: 'info' });
  assert.equal(mailboxIncluded('Spam', policy), true);
  assert.equal(mailboxIncluded('Custom/Projects', policy), true);
});

test('explicit exclusions are honored but cannot be implicit', () => {
  const policy = createSyncPolicy({ accountId: 'info', include: ['**'], exclude: ['Spam', 'Trash'] });
  assert.equal(mailboxIncluded('Inbox', policy), true);
  assert.equal(mailboxIncluded('Spam', policy), false);
  assert.equal(mailboxIncluded('Trash', policy), false);
});

test('policy rejects an empty effective mailbox selection', () => {
  assert.throws(() => createSyncPolicy({ accountId: 'info', include: [], exclude: ['**'] }), /exclude all/);
});
