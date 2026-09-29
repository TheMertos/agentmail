const ALLOWED_TAGS = new Set(['a', 'br', 'div', 'em', 'i', 'li', 'ol', 'p', 'span', 'strong', 'u', 'ul']);

function stripUnsafeAttributes(attributes) {
  return attributes.replace(/\s+[\w:-]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, (attribute) => {
    const match = attribute.match(/^\s*([\w:-]+)\s*=\s*(.*)$/s);
    if (!match) return '';
    const name = match[1].toLowerCase();
    const value = match[2];
    if (name.startsWith('on') || name === 'style' || name === 'srcdoc') return '';
    if (name === 'href' && /^\s*(["']?)\s*javascript:/i.test(value)) return '';
    if (!['href', 'title', 'target', 'rel', 'class', 'alt'].includes(name)) return '';
    return ` ${name}=${value}`;
  });
}

export function sanitizeSignatureHtml(input) {
  if (typeof input !== 'string') throw new TypeError('signature HTML must be a string');
  let html = input
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\/?(?:script|style|iframe|object|embed|form|input|meta|link)[^>]*>/gi, '')
    .replace(/<([a-z][\w:-]*)([^>]*)>/gi, (_, tag, attrs) => {
      const normalized = tag.toLowerCase();
      if (!ALLOWED_TAGS.has(normalized)) return '';
      return `<${normalized}${stripUnsafeAttributes(attrs)}>`;
    })
    .replace(/<\/([a-z][\w:-]*)\s*>/gi, (_, tag) => ALLOWED_TAGS.has(tag.toLowerCase()) ? `</${tag.toLowerCase()}>` : '');

  return html.replace(/\s+(?:href)\s*=\s*(["'])\s*javascript:[\s\S]*?\1/gi, '');
}

export function composeSignatureParts({ html, text }) {
  if (typeof html !== 'string' || typeof text !== 'string') {
    throw new TypeError('signature requires HTML and plain-text parts');
  }
  return { html: sanitizeSignatureHtml(html), text: text.trim() };
}
