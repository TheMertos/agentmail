import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteMailStore } from '../src/storage/sqlite-store.mjs';
import { activateTestAccount, TEST_PRINCIPAL } from './test-principal.mjs';

test('active account list persists activation and excludes inactive accounts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentmail-accounts-'));
  const store = new SqliteMailStore(join(dir, 'mail.db'));
  activateTestAccount(store, { id: 'gmail', email: 'mertyagci35@gmail.com', provider: 'gmail', secretRef: 'resource-gmail', connection: { host: 'imap.gmail.com' } });
  activateTestAccount(store, { id: 'info', email: 'info@mertyagci.de', provider: 'mailbox.org', secretRef: 'resource-info', connection: { host: 'imap.mailbox.org' } });
  assert.deepEqual(store.listActiveAccountsForPrincipal(TEST_PRINCIPAL).map((account) => account.id), ['gmail', 'info']);
  store.deactivateAccount('gmail');
  assert.deepEqual(store.listActiveAccountsForPrincipal(TEST_PRINCIPAL).map((account) => account.id), ['info']);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});
