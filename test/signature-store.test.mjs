import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteMailStore } from '../src/storage/sqlite-store.mjs';

test('signature profiles persist per account, sanitize HTML, and version on update', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentmail-sig-'));
  const store = new SqliteMailStore(join(dir, 'mail.db'));
  const created = store.createSignatureProfile({ accountId: 'info', name: 'Professional HTML', html: '<p>Mert <script>alert(1)</script></p>', text: 'Mert' });
  assert.equal(created.version, 1);
  assert.equal(created.html.includes('<script'), false);

  const updated = store.updateSignatureProfile(created.id, { html: '<p>Updated</p>', text: 'Updated' });
  assert.equal(updated.version, 2);

  store.setDefaultSignature('info', created.id);
  assert.equal(store.getDefaultSignature('info').id, created.id);

  assert.equal(store.listSignatureProfiles('gmail').length, 0);
  assert.equal(store.listSignatureProfiles('info').length, 1);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('signature profile from another account cannot be selected explicitly', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentmail-sig2-'));
  const store = new SqliteMailStore(join(dir, 'mail.db'));
  const gmailProfile = store.createSignatureProfile({ accountId: 'gmail', name: 'Gmail', html: '<p>x</p>', text: 'x' });
  assert.throws(() => store.resolveSignatureForSend({ accountId: 'info', explicitId: gmailProfile.id }), /account/);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});
