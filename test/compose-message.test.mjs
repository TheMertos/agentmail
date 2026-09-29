import test from 'node:test';
import assert from 'node:assert/strict';
import { composeOutgoingMessage } from '../src/core/compose-message.mjs';

test('composes new text, one signature occurrence and quote in order', () => {
  const result = composeOutgoingMessage({
    newText: 'Danke',
    newHtml: '<p>Danke</p>',
    signature: { html: '<p><strong>Mert Yagci</strong></p>', text: 'Mert Yagci' },
    quoteText: '> alte Nachricht',
    quoteDepth: 1
  });
  assert.equal((result.html.match(/Mert Yagci/g) ?? []).length, 1);
  assert.ok(result.html.indexOf('Danke') < result.html.indexOf('Mert Yagci'));
  assert.ok(result.html.indexOf('Mert Yagci') < result.html.indexOf('alte Nachricht'));
  assert.match(result.text, /^Danke\n\nMert Yagci\n\n> alte Nachricht$/);
});

test('composes without a signature when none is selected', () => {
  const result = composeOutgoingMessage({ newText: 'Hi', newHtml: '<p>Hi</p>', quoteText: 'old' });
  assert.equal(result.html.includes('gmail_quote'), true);
  assert.equal(result.text, 'Hi\n\n> old');
});
