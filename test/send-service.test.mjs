import test from 'node:test';
import assert from 'node:assert/strict';
import { sendAndSaveSent } from '../src/mail/send-service.mjs';

test('send saves the exact MIME message to Sent and verifies it', async () => {
  const calls = [];
  const result = await sendAndSaveSent({
    accountId: 'info',
    mime: 'Message-ID: <abc@example.test>\r\n\r\nHello',
    smtp: { send: async (mime) => { calls.push(['smtp', mime]); return { accepted: ['x@example.test'] }; } },
    imap: {
      findSentMailbox: async () => 'Sent Items',
      append: async (mailbox, mime, flags) => { calls.push(['append', mailbox, mime, flags]); return { uid: 55 }; },
      readByUid: async (mailbox, uid) => { calls.push(['read', mailbox, uid]); return 'Message-ID: <abc@example.test>\r\n\r\nHello'; }
    }
  });
  assert.equal(result.status, 'sent_and_saved');
  assert.equal(result.uid, 55);
  assert.deepEqual(calls.map((call) => call[0]), ['smtp', 'append', 'read']);
});

test('successful SMTP with failed Sent append reports partial completion and never retries SMTP', async () => {
  let smtpCalls = 0;
  await assert.rejects(() => sendAndSaveSent({
    accountId: 'info',
    mime: 'Message-ID: <abc@example.test>\r\n\r\nHello',
    smtp: { send: async () => { smtpCalls += 1; return { accepted: ['x@example.test'] }; } },
    imap: { findSentMailbox: async () => 'Sent', append: async () => { throw new Error('append_failed'); }, readByUid: async () => '' }
  }), /sent_copy_failed/);
  assert.equal(smtpCalls, 1);
});

test('accepted SMTP with unverified Sent read-back never claims sent_and_saved', async () => {
  let smtpCalls = 0;
  await assert.rejects(() => sendAndSaveSent({
    accountId: 'info',
    mime: 'Message-ID: <abc@example.test>\r\n\r\nHello',
    smtp: { send: async () => { smtpCalls += 1; return { accepted: ['x@example.test'] }; } },
    imap: {
      findSentMailbox: async () => 'Sent',
      append: async () => ({ uid: 77 }),
      readByUid: async () => { throw new Error('readback_unavailable'); }
    }
  }), /sent_copy_unverified/);
  assert.equal(smtpCalls, 1);
});

test('Sent append is not enough: the exact normalized MIME must be read back', async () => {
  await assert.rejects(() => sendAndSaveSent({
    accountId: 'info',
    mime: 'Message-ID: <abc@example.test>\n\nHello',
    smtp: { send: async () => ({ accepted: ['x@example.test'] }) },
    imap: {
      findSentMailbox: async () => 'Sent',
      append: async () => ({ uid: 78 }),
      readByUid: async () => 'Message-ID: <different@example.test>\r\n\r\nHello'
    }
  }), /sent_copy_verification_failed/);
});
