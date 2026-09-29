import test from 'node:test';
import assert from 'node:assert/strict';
import { MailService } from '../src/mail/mail-service.mjs';

test('mailbox list returns provider folders without credential material', async () => {
  const service = new MailService({
    accountRegistry: { get: (id) => id === 'info' ? { id, email: 'info@example.test', provider: 'imap' } : null },
    leaseBroker: { acquire: async () => ({ leaseId: 'lease-1' }) },
    providerFactory: async () => ({ listMailboxes: async () => [{ path: 'INBOX', specialUse: '\\Inbox', total: 12, unseen: 3 }], close: async () => {} })
  });
  const result = await service.listMailboxes('info');
  assert.deepEqual(result, [{ path: 'INBOX', specialUse: '\\Inbox', total: 12, unseen: 3 }]);
});

test('mailbox list fails closed when account is missing', async () => {
  const service = new MailService({ accountRegistry: { get: () => null } });
  await assert.rejects(() => service.listMailboxes('missing'), /account_not_found/);
});

test('mailbox list rejects a lease containing plaintext credentials', async () => {
  const service = new MailService({
    accountRegistry: { get: () => ({ id: 'info', email: 'info@example.test', provider: 'imap' }) },
    leaseBroker: { acquire: async () => ({ leaseId: 'lease-1', password: 'must-not-pass' }) },
    providerFactory: async () => ({ listMailboxes: async () => [], close: async () => {} })  });
  await assert.rejects(() => service.listMailboxes('info'), /plaintext credential/);
});
