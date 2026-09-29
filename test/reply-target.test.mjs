import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveReplyTarget } from '../src/mail/reply-target.mjs';

function store(message) {
  return { getMessage: (key) => (key === message.key ? message : null) };
}

test('resolves headers and quote source from the exact stored message', () => {
  const message = {
    key: 'info:inbox:v1:9',
    accountId: 'info',
    envelope: { messageId: '<orig@example.test>', from: [{ address: 'sender@example.test' }], subject: 'Angebot', date: '2024-01-01T00:00:00.000Z' },
    raw: 'Message-ID: <orig@example.test>\r\nSubject: Angebot\r\n\r\n<p>Hallo</p>'
  };
  const target = resolveReplyTarget({ store: store(message), accountId: 'info', sourceMessageKey: message.key, mode: 'reply' });
  assert.equal(target.headers.inReplyTo, '<orig@example.test>');
  assert.equal(target.headers.subject, 'Re: Angebot');
  assert.equal(target.headers.to[0].address, 'sender@example.test');
});

test('fails closed when the message key does not exist locally', () => {
  assert.throws(() => resolveReplyTarget({ store: store({ key: 'x' }), accountId: 'info', sourceMessageKey: 'missing', mode: 'reply' }), /source_message_not_found/);
});

test('fails closed on cross-account reply target', () => {
  const message = { key: 'gmail:inbox:v1:1', accountId: 'gmail', envelope: { messageId: '<a@x>', from: [{ address: 'a@x.test' }], subject: 'Hi' }, raw: 'x' };
  assert.throws(() => resolveReplyTarget({ store: store(message), accountId: 'info', sourceMessageKey: message.key, mode: 'reply' }), /account_mismatch/);
});
