import test from 'node:test';
import assert from 'node:assert/strict';
import { composeSignatureParts, sanitizeSignatureHtml } from '../src/core/signatures.mjs';

test('sanitizes executable HTML and keeps safe markup', () => {
  const html = '<div onclick="alert(1)">Hello</div><script>alert(2)</script><a href="javascript:alert(3)">x</a>';
  const safe = sanitizeSignatureHtml(html);
  assert.equal(safe.includes('onclick'), false);
  assert.equal(safe.includes('<script'), false);
  assert.equal(safe.includes('javascript:'), false);
  assert.match(safe, /Hello/);
});

test('renders HTML and plain-text signature exactly once', () => {
  const parts = composeSignatureParts({
    html: '<p><strong>Mert Yagci</strong></p>',
    text: 'Mert Yagci'
  });
  assert.equal(parts.html, '<p><strong>Mert Yagci</strong></p>');
  assert.equal(parts.text, 'Mert Yagci');
});
