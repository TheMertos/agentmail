import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccountRegistry } from '../src/core/account-registry.mjs';

test('registry lists account metadata without the opaque secret reference', () => {
  const registry = createAccountRegistry([{ id: 'info', email: 'info@example.test', provider: 'imap', secretRef: 'sf-resource-1', connection: { imapHost: 'imap.example.test' } }]);
  assert.deepEqual(registry.list()[0], { id: 'info', label: 'info@example.test', email: 'info@example.test', provider: 'imap', connection: { imapHost: 'imap.example.test' }, status: 'disconnected', hasCredentialReference: true });
});

test('registry rejects plaintext credential fields', () => {
  const registry = createAccountRegistry();
  assert.throws(() => registry.register({ id: 'bad', email: 'bad@example.test', provider: 'imap', secretRef: 'ref', connection: { password: 'never' } }), /not allowed/);
});
