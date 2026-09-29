import test from 'node:test';
import assert from 'node:assert/strict';
import { composeSignatureParts, sanitizeSignatureHtml } from '../src/core/signatures.mjs';

test('sanitizes executable HTML but preserves email-safe tables and inline styles', () => {
  const html = '<table style="border:1px solid #ccc"><tr><td style="color:#005ea6">Hello</td></tr></table><script>alert(2)</script><a href="javascript:alert(3)">x</a>';
  const safe = sanitizeSignatureHtml(html);
  assert.equal(safe.includes('<table'), true);
  assert.equal(safe.includes('<td'), true);
  assert.equal(safe.includes('border:1px solid #ccc'), true);
  assert.equal(safe.includes('color:#005ea6'), true);
  assert.equal(safe.includes('<script'), false);
  assert.equal(safe.includes('javascript:'), false);
});

test('renders HTML and plain-text signature exactly once', () => {
  const parts = composeSignatureParts({
    html: '<p><strong>Mert Yagci</strong></p>',
    text: 'Mert Yagci'
  });
  assert.equal(parts.html, '<p><strong>Mert Yagci</strong></p>');
  assert.equal(parts.text, 'Mert Yagci');
});
