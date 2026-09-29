import test from 'node:test';
import assert from 'node:assert/strict';
import { folderSyncProgress, accountSyncProgress } from '../src/mail/sync-progress.mjs';

test('folder progress uses remote message count when reliable', () => {
  const progress = folderSyncProgress({
    remoteMessages: 100,
    localCount: 40,
    uidNext: 141,
    lastUid: 40,
    state: 'syncing'
  });
  assert.equal(progress.downloadedCount, 40);
  assert.equal(progress.remaining, 60);
  assert.equal(progress.percentage, 40);
  assert.equal(progress.percentageReason, undefined);
});

test('folder progress returns null percentage when remote total is unknown', () => {
  const progress = folderSyncProgress({
    remoteMessages: null,
    localCount: 10,
    uidNext: null,
    lastUid: 10,
    state: 'syncing'
  });
  assert.equal(progress.percentage, null);
  assert.match(progress.percentageReason, /remote total/i);
});

test('account progress never guesses when any folder lacks a reliable total', () => {
  const progress = accountSyncProgress([
    { folderId: 'inbox', remoteMessages: 50, localCount: 25, uidNext: 51, lastUid: 25, state: 'syncing' },
    { folderId: 'custom', remoteMessages: null, localCount: 3, uidNext: null, lastUid: 3, state: 'syncing' }
  ]);
  assert.equal(progress.percentage, null);
  assert.match(progress.percentageReason, /custom/i);
});

test('account progress never reports 100% when there are no folder checkpoints', () => {
  const progress = accountSyncProgress([]);
  assert.equal(progress.downloadedCount, 0);
  assert.equal(progress.remoteCount, null);
  assert.equal(progress.percentage, null);
  assert.match(progress.percentageReason, /checkpoint|remote total/i);
});

test('account progress aggregates reliable folder totals', () => {
  const progress = accountSyncProgress([
    { folderId: 'inbox', remoteMessages: 100, localCount: 50, uidNext: 101, lastUid: 50, state: 'syncing' },
    { folderId: 'sent', remoteMessages: 20, localCount: 10, uidNext: 21, lastUid: 10, state: 'syncing' }
  ]);
  assert.equal(progress.downloadedCount, 60);
  assert.equal(progress.remoteCount, 120);
  assert.equal(progress.remaining, 60);
  assert.equal(progress.percentage, 50);
});
