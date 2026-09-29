const ALLOWED_TAGS = new Set(['a', 'br', 'div', 'em', 'i', 'li', 'ol', 'p', 'span', 'strong', 'u', 'ul', 'table', 'tbody', 'thead', 'tfoot', 'tr', 'td', 'th']);
const ALLOWED_ATTRIBUTES = new Set(['href', 'title', 'target', 'rel', 'class', 'alt', 'role', 'cellpadding', 'cellspacing', 'cellpadding', 'border', 'width', 'height', 'colspan', 'rowspan', 'valign', 'align']);
const SAFE_STYLE_PROPERTIES = new Set(['background', 'background-color', 'border', 'border-left', 'border-right', 'border-top', 'border-bottom', 'border-collapse', 'border-radius', 'box-shadow', 'color', 'display', 'font-family', 'font-size', 'font-style', 'font-weight', 'letter-spacing', 'line-height', 'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'max-width', 'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'text-decoration', 'vertical-align', 'width', 'height']);

function sanitizeStyle(value) {
  return value.split(';').map((declaration) => {
    const [property, ...parts] = declaration.split(':');
    const normalizedProperty = property?.trim().toLowerCase();
    const normalizedValue = parts.join(':').trim();
    if (!normalizedProperty || !normalizedValue || !SAFE_STYLE_PROPERTIES.has(normalizedProperty)) return '';
    if (/url\s*\(|expression\s*\(|javascript:|behavior\s*:/i.test(normalizedValue)) return '';
    return `${normalizedProperty}:${normalizedValue}`;
  }).filter(Boolean).join(';');
}

function stripUnsafeAttributes(attributes) {
  return attributes.replace(/\s+([\w:-]+)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, (attribute, rawName, rawValue) => {
    const name = rawName.toLowerCase();
    const value = rawValue;
    if (name.startsWith('on') || name === 'srcdoc') return '';
    if (name === 'style') {
      const unquoted = value.replace(/^['"]|['"]$/g, '');
      const safeStyle = sanitizeStyle(unquoted);
      return safeStyle ? ` style="${safeStyle}"` : '';
    }
    if (!ALLOWED_ATTRIBUTES.has(name)) return '';
    if (name === 'href' && /^(?:\s*['"]?\s*)?(?:javascript:|data:)/i.test(value)) return '';
    return ` ${name}=${value}`;
  });
}

export function sanitizeSignatureHtml(input) {
  if (typeof input !== 'string') throw new TypeError('signature HTML must be a string');
  let html = input
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\/?(?:script|iframe|object|embed|form|input|meta|link|style)[^>]*>/gi, '')
    .replace(/<([a-z][\w:-]*)([^>]*)>/gi, (_, tag, attrs) => {
      const normalized = tag.toLowerCase();
      if (!ALLOWED_TAGS.has(normalized)) return '';
      return `<${normalized}${stripUnsafeAttributes(attrs)}>`;
    })
    .replace(/<\/([a-z][\w:-]*)\s*>/gi, (_, tag) => ALLOWED_TAGS.has(tag.toLowerCase()) ? `</${tag.toLowerCase()}>` : '');

  return html.replace(/\s+(?:href)\s*=\s*(["'])\s*(?:javascript:|data:)[\s\S]*?\1/gi, '');
}

export function composeSignatureParts({ html, text }) {
  if (typeof html !== 'string' || typeof text !== 'string') throw new TypeError('signature requires HTML and plain-text parts');
  return { html: sanitizeSignatureHtml(html), text: text.trim() };
}
