import test from 'node:test';
import assert from 'node:assert/strict';
import { composeReplyParts } from '../src/mail/reply-format.mjs';

test('reply keeps new text above a nested HTML blockquote', () => {
  const result = composeReplyParts({
    newHtml: '<p>Danke für Ihre Nachricht.</p>',
    newText: 'Danke für Ihre Nachricht.',
    quoteHtml: '<p>Originale Nachricht</p>',
    quoteText: 'Originale Nachricht',
    quoteDepth: 2
  });
  assert.ok(result.html.indexOf('Danke für Ihre Nachricht.') < result.html.indexOf('Originale Nachricht'));
  assert.equal((result.html.match(/class="gmail_quote"/g) ?? []).length, 2);
  assert.equal(result.html.includes('&gt;'), false);
  assert.match(result.text, /^Danke für Ihre Nachricht\.\n\n>> Originale Nachricht$/);
});

test('plain-only source becomes HTML blockquote without visible quote markers', () => {
  const result = composeReplyParts({ newHtml: '<p>Reply</p>', newText: 'Reply', quoteText: '> First\n> Second' });
  assert.equal(result.html.includes('&gt;'), false);
  assert.match(result.html, /First[\s\S]*Second/);
  assert.match(result.text, /\n> First\n> Second$/);
});
