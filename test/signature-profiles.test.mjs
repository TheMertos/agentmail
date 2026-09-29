import test from 'node:test';
import assert from 'node:assert/strict';
import { selectSignatureProfile } from '../src/core/signature-profiles.mjs';

const profiles = [
  { id: 'info-html', accountId: 'info', name: 'Professional HTML', enabled: true },
  { id: 'gmail-html', accountId: 'gmail', name: 'Gmail HTML', enabled: true },
  { id: 'info-disabled', accountId: 'info', name: 'Old', enabled: false }
];

test('explicit signature selection is restricted to the active account', () => {
  assert.throws(() => selectSignatureProfile(profiles, { accountId: 'info', explicitId: 'gmail-html' }), /account/);
});

test('account default is selected when no explicit profile is given', () => {
  const selected = selectSignatureProfile(profiles, { accountId: 'info', defaultId: 'info-html' });
  assert.equal(selected.id, 'info-html');
});

test('disabled or missing signature resolves to null', () => {
  assert.equal(selectSignatureProfile(profiles, { accountId: 'info', explicitId: 'info-disabled' }), null);
  assert.equal(selectSignatureProfile(profiles, { accountId: 'unknown' }), null);
});
