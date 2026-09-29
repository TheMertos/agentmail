function escapeHtml(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function stripPlainQuoteMarkers(value) {
  return value.split(/\r?\n/).map((line) => line.replace(/^\s*>\s?/, '')).join('\n');
}

function nestedBlockquote(content, depth) {
  let result = content;
  for (let index = 0; index < depth; index += 1) {
    result = `<blockquote class="gmail_quote" style="border-left:1px #ccc solid;padding-left:1ex;margin-left:0">${result}</blockquote>`;
  }
  return result;
}

export function composeReplyParts({ newHtml, newText, quoteHtml, quoteText, quoteDepth = 1 }) {
  if (!newHtml || !newText || (!quoteHtml && !quoteText)) throw new TypeError('new content and quoted content are required');
  const depth = Math.max(1, Math.min(10, Number(quoteDepth) || 1));
  const cleanQuoteText = stripPlainQuoteMarkers(quoteText ?? '');
  const sourceHtml = quoteHtml ?? escapeHtml(cleanQuoteText).replaceAll('\n', '<br>');
  const html = `${newHtml}${nestedBlockquote(sourceHtml, depth)}`;
  const textQuote = cleanQuoteText.split('\n').map((line) => `${'>'.repeat(depth)} ${line}`).join('\n');
  return { html, text: `${newText}\n\n${textQuote}` };
}
