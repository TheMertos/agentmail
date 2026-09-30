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

test('wraps a raw quote in exactly one canonical reply blockquote', () => {
  const result = composeOutgoingMessage({
    newText: 'Reply',
    newHtml: '<p>Reply</p>',
    quoteText: 'Original',
    quoteHtml: '<p><em>Original</em></p>'
  });

  assert.equal((result.html.match(/<blockquote\b/g) ?? []).length, 1);
  assert.equal((result.html.match(/class="gmail_quote"/g) ?? []).length, 1);
  assert.match(result.html, /<em>Original<\/em>/);
  assert.equal(result.text, 'Reply\n\n> Original');
});

test('normalizes already wrapped quoteHtml without adding a second quote bar', () => {
  const result = composeOutgoingMessage({
    newText: 'Reply',
    newHtml: '<p>Reply</p>',
    quoteText: '> Original',
    quoteHtml: '<blockquote class="gmail_quote"><p>Original</p></blockquote>'
  });

  assert.equal((result.html.match(/<blockquote\b/g) ?? []).length, 1);
  assert.equal((result.html.match(/class="gmail_quote"/g) ?? []).length, 1);
  assert.equal(result.text, 'Reply\n\n> Original');
});

test('preserves a genuine nested source quote while removing its outer wrapper', () => {
  const result = composeOutgoingMessage({
    newText: 'Reply',
    newHtml: '<p>Reply</p>',
    quoteText: '> Outer\n>> Inner',
    quoteHtml: '<blockquote class="gmail_quote"><p>Outer</p><blockquote><p>Inner</p></blockquote></blockquote>'
  });

  assert.equal((result.html.match(/<blockquote\b/g) ?? []).length, 2);
  assert.equal((result.html.match(/class="gmail_quote"/g) ?? []).length, 1);
  assert.match(result.html, /Outer[\s\S]*<blockquote><p>Inner<\/p><\/blockquote>/);
  assert.equal(result.text, 'Reply\n\n> Outer\n>> Inner');
});
