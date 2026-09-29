import test from 'node:test';
import assert from 'node:assert/strict';
import { createLeaseBroker } from '../src/security/lease-broker.mjs';
import { MailService } from '../src/mail/mail-service.mjs';

test('mail service resolves mailboxes end-to-end through a real lease broker and provider factory', async () => {
  const resolver = async ({ accountId }) => ({ username: `${accountId}@example.test`, password: 'secret' });
  const leaseBroker = createLeaseBroker({ resolver });
  let providerCredentials;
  const providerFactory = async ({ lease }) => {
    const credentials = leaseBroker.getPrivate(lease.leaseId);
    providerCredentials = { username: credentials.username };
    return { listMailboxes: async () => [{ path: 'INBOX' }], close: async () => {} };
  };
  const service = new MailService({
    accountRegistry: { get: (id) => ({ id, email: `${id}@example.test`, provider: 'imap' }) },
    leaseBroker,
    providerFactory
  });
  const mailboxes = await service.listMailboxes('info');
  assert.deepEqual(mailboxes, [{ path: 'INBOX' }]);
  assert.equal(providerCredentials.username, 'info@example.test');
});
