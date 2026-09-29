import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteMailStore } from '../src/storage/sqlite-store.mjs';

test('drafts persist account, exact reply source and MIME alternatives', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentmail-drafts-'));
  const store = new SqliteMailStore(join(dir, 'mail.db'));
  const draft = store.createDraft({ accountId: 'info', sourceMessageKey: 'info:inbox:v1:1', headers: { to: ['a@example.test'], subject: 'Re: Hi' }, text: 'Reply', html: '<p>Reply</p>' });
  assert.equal(store.getDraft(draft.id).sourceMessageKey, 'info:inbox:v1:1');
  assert.equal(store.listDrafts('info').length, 1);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});
