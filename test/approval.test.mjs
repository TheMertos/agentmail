import test from 'node:test';
import assert from 'node:assert/strict';
import { createApproval, verifyApproval } from '../src/core/approval.mjs';

test('approval verifies for the exact reviewed payload', () => {
  const payload = {
    accountId: 'info',
    to: ['recipient@example.com'],
    subject: 'Reviewed subject',
    text: 'Reviewed body',
    html: '<p>Reviewed body</p>',
    quote: '<blockquote>Original</blockquote>',
    signatureVersion: 3,
    attachments: []
  };
  const approval = createApproval(payload, { ttlSeconds: 300, now: 1_700_000_000 });
  assert.equal(verifyApproval(approval, payload, 1_700_000_100), true);
});

test('approval fails when a recipient changes', () => {
  const payload = { accountId: 'a', to: ['a@example.com'], subject: 's', text: 'b', signatureVersion: 1 };
  const approval = createApproval(payload, { ttlSeconds: 300, now: 1_700_000_000 });
  assert.equal(verifyApproval(approval, { ...payload, to: ['evil@example.com'] }, 1_700_000_001), false);
});

test('approval fails after expiry', () => {
  const payload = { accountId: 'a', to: ['a@example.com'], subject: 's', text: 'b' };
  const approval = createApproval(payload, { ttlSeconds: 60, now: 1_700_000_000 });
  assert.equal(verifyApproval(approval, payload, 1_700_000_061), false);
});
