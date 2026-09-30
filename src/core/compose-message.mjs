import { composeSignatureParts } from './signatures.mjs';

const CANONICAL_QUOTE = '<blockquote class="gmail_quote" style="border-left:1px #ccc solid;padding-left:1ex;margin-left:0">';

/**
 * Remove blockquote elements that wrap the complete source fragment.
 * Nested blockquotes inside real message content are intentionally retained.
 * @param {string} sourceHtml Source quote fragment.
 * @returns {string} Unwrapped source fragment.
 */
function unwrapOuterBlockquotes(sourceHtml) {
  let result = sourceHtml.trim();
  while (result.toLowerCase().startsWith('<blockquote')) {
    const tags = [...result.matchAll(/<\/?blockquote\b[^>]*>/gi)];
    if (!tags.length || !tags[0][0].startsWith('<blockquote')) break;
    let depth = 0;
    let closingTag;
    for (const tag of tags) {
      if (tag[0][1] === '/') depth -= 1;
      else depth += 1;
      if (depth === 0) {
        closingTag = tag;
        break;
      }
    }
    if (!closingTag || result.slice(closingTag.index + closingTag[0].length).trim() !== '') break;
    result = result.slice(tags[0].index + tags[0][0].length, closingTag.index).trim();
  }
  return result;
}

function normalizeQuoteText(value, depth) {
  return value.split(/\r?\n/).map((line) => {
    const marker = /^\s*((?:>\s*)+)/.exec(line);
    const existingDepth = marker ? (marker[1].match(/>/g) ?? []).length : 0;
    const content = marker ? line.slice(marker[0].length) : line;
    return `${'>'.repeat(Math.max(depth, existingDepth))} ${content}`;
  }).join('\n');
}

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
  const rawQuoteText = String(quoteText ?? '');
  const cleanQuoteText = normalizeQuoteText(rawQuoteText, depth);
  const sourceHtml = quoteHtml ?? rawQuoteText.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('\n', '<br>');
  const wrapped = `${CANONICAL_QUOTE}${unwrapOuterBlockquotes(sourceHtml)}</blockquote>`;
  const textQuote = cleanQuoteText;

  return {
    text: [...textParts, textQuote].join('\n\n'),
    html: [...htmlParts, wrapped].join('')
  };
}
