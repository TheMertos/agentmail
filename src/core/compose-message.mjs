import { composeSignatureParts } from './signatures.mjs';

export function composeOutgoingMessage({ newText, newHtml, signature, quoteText, quoteHtml, quoteDepth }) {
  if (!newText || !newHtml) throw new TypeError('newText and newHtml are required');
  const sig = signature ? composeSignatureParts({ html: signature.html, text: signature.text }) : null;

  const textParts = [newText];
  if (sig) textParts.push(sig.text);
  const htmlParts = [newHtml];
  if (sig) htmlParts.push(sig.html);

  if (!quoteText && !quoteHtml) {
    return { text: textParts.join('\n\n'), html: htmlParts.join('') };
  }

  const depth = quoteDepth ?? 1;
  const cleanQuoteText = String(quoteText ?? '').split(/\r?\n/).map((line) => line.replace(/^\s*>\s?/, '')).join('\n');
  const sourceHtml = quoteHtml ?? cleanQuoteText.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('\n', '<br>');
  let wrapped = sourceHtml;
  for (let i = 0; i < depth; i += 1) {
    wrapped = `<blockquote class="gmail_quote" style="border-left:1px #ccc solid;padding-left:1ex;margin-left:0">${wrapped}</blockquote>`;
  }
  const textQuote = cleanQuoteText.split('\n').map((line) => `${'>'.repeat(depth)} ${line}`).join('\n');

  return {
    text: [...textParts, textQuote].join('\n\n'),
    html: [...htmlParts, wrapped].join('')
  };
}
