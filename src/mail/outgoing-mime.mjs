import { createHash } from 'node:crypto';
import { attachmentError } from './attachment-policy.mjs';

/**
 * Split a CRLF MIME header block into unfolded headers.
 * @param {string} headerText Header block without the separating blank line.
 * @returns {{ name: string, value: string }[]}
 */
function unfoldHeaders(headerText) {
  const headers = [];
  for (const line of headerText.split('\r\n')) {
    if (/^[ \t]/.test(line)) {
      if (!headers.length) throw attachmentError('mime_invalid');
      headers[headers.length - 1].value += ` ${line.trim()}`;
      continue;
    }
    const match = /^([^:]+):\s*(.*)$/.exec(line);
    if (!match) throw attachmentError('mime_invalid');
    headers.push({ name: match[1], value: match[2] });
  }
  return headers;
}

/**
 * Build a boundary that does not occur in the reviewed message or attachment bodies.
 * @param {string} mime Reviewed MIME.
 * @param {Array<{ content: Buffer }>} attachments Attachment bytes.
 * @returns {string}
 */
function uniqueBoundary(mime, attachments) {
  const hash = createHash('sha256').update(mime);
  for (const attachment of attachments) hash.update(attachment.content);
  let boundary = `agentmail_${hash.digest('hex').slice(0, 24)}`;
  const haystack = `${mime}\n${attachments.map((attachment) => attachment.content.toString('base64')).join('\n')}`;
  while (haystack.includes(boundary)) boundary += 'x';
  return boundary;
}

/**
 * Wrap base64 at 76 columns.
 * @param {Buffer} content Raw bytes.
 * @returns {string}
 */
function wrapBase64(content) {
  const lines = content.toString('base64').match(/.{1,76}/g) ?? [];
  return `${lines.join('\r\n')}\r\n`;
}

/**
 * Render one MIME part, including a trailing CRLF on the body.
 * @param {{ name: string, value: string }[]} headers Part headers.
 * @param {string} body Part body.
 * @returns {string}
 */
function renderPart(headers, body) {
  const head = headers.map((header) => `${header.name}: ${header.value}`).join('\r\n');
  const text = body.endsWith('\r\n') ? body : `${body}\r\n`;
  return `${head}\r\n\r\n${text}`;
}

/**
 * Read one header value.
 * @param {{ name: string, value: string }[]} headers Parsed headers.
 * @param {string} name Header name.
 * @returns {string}
 */
function headerValue(headers, name) {
  return headers.find((header) => header.name.toLowerCase() === name.toLowerCase())?.value ?? '';
}

/**
 * True for MIME content headers that describe a body part rather than the message envelope.
 * @param {string} name Header name.
 * @returns {boolean}
 */
function isMimeContentHeader(name) {
  const lower = name.toLowerCase();
  return lower === 'content-type' || lower === 'content-transfer-encoding' || lower === 'content-disposition' || lower === 'content-id';
}

/**
 * True when a MIME part is an incoming inline or attached file.
 * Plain and HTML quote parts are kept.
 * @param {{ name: string, value: string }[]} headers Part headers.
 * @returns {boolean}
 */
function isIncomingFilePart(headers) {
  const type = headerValue(headers, 'content-type').toLowerCase();
  const disposition = headerValue(headers, 'content-disposition').toLowerCase();
  if (type.startsWith('multipart/')) return false;
  if ((type.startsWith('text/plain') || type.startsWith('text/html') || type === '') && !disposition.startsWith('attachment')) {
    return false;
  }
  if (disposition.startsWith('attachment') || disposition.startsWith('inline')) return true;
  if (headerValue(headers, 'content-id')) return true;
  if (type.startsWith('text/')) return false;
  return type.startsWith('application/') || type.startsWith('image/') || type.startsWith('audio/') || type.startsWith('video/');
}

/**
 * Read the multipart boundary parameter.
 * @param {string} contentType Content-Type header value.
 * @returns {string|null}
 */
function boundaryOf(contentType) {
  const quoted = /boundary="([^"]+)"/i.exec(contentType);
  if (quoted) return quoted[1];
  const bare = /boundary=([^;\s]+)/i.exec(contentType);
  return bare?.[1] ?? null;
}

/**
 * Split a multipart body into raw part blocks, excluding the preamble and closing marker.
 * @param {string} body Multipart body.
 * @param {string} boundary Boundary token.
 * @returns {string[]}
 */
function splitMultipart(body, boundary) {
  const delimiter = `--${boundary}`;
  if (!body.includes(delimiter)) throw attachmentError('mime_invalid');
  const parts = [];
  const segments = body.split(delimiter);
  for (let index = 1; index < segments.length; index += 1) {
    let segment = segments[index];
    if (segment.startsWith('--')) break;
    if (segment.startsWith('\r\n')) segment = segment.slice(2);
    if (segment.endsWith('\r\n')) segment = segment.slice(0, -2);
    if (segment.length > 0) parts.push(segment);
  }
  return parts;
}

/**
 * Render headers and a body as one MIME entity.
 * @param {{ name: string, value: string }[]} headers Headers.
 * @param {string} body Body text.
 * @returns {string}
 */
function renderMessage(headers, body) {
  const head = headers.map((header) => `${header.name}: ${header.value}`).join('\r\n');
  const text = body.endsWith('\r\n') ? body : `${body}\r\n`;
  return `${head}\r\n\r\n${text}`;
}

/**
 * Replace content headers while preserving the message envelope.
 * @param {{ name: string, value: string }[]} headers Original headers.
 * @param {{ name: string, value: string }[]} contentHeaders Replacement content headers.
 * @returns {{ name: string, value: string }[]}
 */
function replaceContentHeaders(headers, contentHeaders) {
  const next = [...headers.filter((header) => !isMimeContentHeader(header.name)), ...contentHeaders];
  if (!next.some((header) => header.name.toLowerCase() === 'mime-version')) {
    next.push({ name: 'MIME-Version', value: '1.0' });
  }
  return next;
}

/**
 * Rebuild a multipart entity from kept child parts.
 * @param {string} subtype Multipart subtype such as alternative or mixed.
 * @param {Array<{ contentHeaders: { name: string, value: string }[], body: string }>} parts Kept parts.
 * @returns {{ multipart: true, contentHeaders: { name: string, value: string }[], body: string }}
 */
function rebuildMultipart(subtype, parts) {
  const rendered = parts.map((part) => renderMessage(part.contentHeaders, part.body));
  let boundary = `agentmail_quote_${createHash('sha256').update(rendered.join('\n')).digest('hex').slice(0, 24)}`;
  const haystack = rendered.join('\n');
  while (haystack.includes(boundary)) boundary += 'x';
  const body = `${rendered.map((part) => `--${boundary}\r\n${part}`).join('')}--${boundary}--\r\n`;
  return {
    multipart: true,
    contentHeaders: [{ name: 'Content-Type', value: `multipart/${subtype}; boundary="${boundary}"` }],
    body
  };
}

/**
 * Remove incoming inline and attached file parts, keeping quote text and HTML.
 * A message that is not multipart is returned unchanged aside from CRLF normalization.
 * @param {{ name: string, value: string }[]} headers Entity headers.
 * @param {string} body Entity body.
 * @returns {{ multipart?: boolean, contentHeaders: { name: string, value: string }[], body: string }|null}
 */
function cleanEntity(headers, body) {
  const type = headerValue(headers, 'content-type');
  if (!/^multipart\//i.test(type)) {
    if (isIncomingFilePart(headers)) return null;
    const contentHeaders = headers.filter((header) => isMimeContentHeader(header.name));
    return {
      contentHeaders: contentHeaders.length ? contentHeaders : [{ name: 'Content-Type', value: 'text/plain; charset=utf-8' }],
      body
    };
  }
  const boundary = boundaryOf(type);
  if (!boundary) throw attachmentError('mime_invalid');
  const kept = [];
  for (const part of splitMultipart(body, boundary)) {
    const parsed = splitHeaderBody(part.replace(/\r?\n/g, '\r\n'));
    const child = cleanEntity(parsed.headers, parsed.body);
    if (child) kept.push(child);
  }
  if (kept.length === 0) return null;
  if (kept.length === 1 && !kept[0].multipart) return kept[0];
  const subtype = /^multipart\/([A-Za-z0-9.+-]+)/i.exec(type)?.[1] ?? 'mixed';
  return rebuildMultipart(subtype, kept);
}

/**
 * Split a CRLF MIME entity into headers and body.
 * @param {string} mime MIME entity using CRLF.
 * @returns {{ headers: { name: string, value: string }[], body: string }}
 */
function splitHeaderBody(mime) {
  const splitAt = mime.indexOf('\r\n\r\n');
  if (splitAt < 0) throw attachmentError('mime_invalid');
  return { headers: unfoldHeaders(mime.slice(0, splitAt)), body: mime.slice(splitAt + 4) };
}

/**
 * Keep the quote and envelope from a reviewed MIME message and drop incoming file parts.
 * @param {string} mime Reviewed MIME, which may be a stored source message.
 * @returns {string}
 */
function stripInheritedFileParts(mime) {
  if (typeof mime !== 'string' || mime.length === 0) throw attachmentError('mime_invalid');
  const normalized = mime.replace(/\r?\n/g, '\r\n');
  const parsed = splitHeaderBody(normalized);
  const cleaned = cleanEntity(parsed.headers, parsed.body);
  if (!cleaned) {
    return renderMessage(
      replaceContentHeaders(parsed.headers, [{ name: 'Content-Type', value: 'text/plain; charset=utf-8' }]),
      ''
    );
  }
  return renderMessage(replaceContentHeaders(parsed.headers, cleaned.contentHeaders), cleaned.body);
}

/**
 * Append attachment bytes to a reviewed MIME message as multipart/mixed.
 * An empty attachment list returns the reviewed MIME unchanged.
 * Incoming inline and attached file parts in the reviewed MIME are not copied.
 * @param {{ mime: string, attachments?: Array<{ filename: string, contentType: string, content: Buffer }> }} input Reviewed MIME and attachment bytes.
 * @returns {string}
 */
export function assembleOutgoingMime({ mime, attachments = [] }) {
  if (!Array.isArray(attachments) || attachments.length === 0) return mime;
  if (typeof mime !== 'string' || mime.length === 0) throw attachmentError('mime_invalid');
  const normalized = stripInheritedFileParts(mime);
  const splitAt = normalized.indexOf('\r\n\r\n');
  if (splitAt < 0) throw attachmentError('mime_invalid');
  const headers = unfoldHeaders(normalized.slice(0, splitAt));
  const body = normalized.slice(splitAt + 4);
  const moved = [];
  const kept = [];
  for (const header of headers) {
    const name = header.name.toLowerCase();
    if (name === 'content-type' || name === 'content-transfer-encoding' || name === 'content-disposition') moved.push(header);
    else kept.push(header);
  }
  if (!kept.some((header) => header.name.toLowerCase() === 'mime-version')) {
    kept.push({ name: 'MIME-Version', value: '1.0' });
  }
  const boundary = uniqueBoundary(normalized, attachments);
  kept.push({ name: 'Content-Type', value: `multipart/mixed; boundary="${boundary}"` });
  const bodyType = moved.find((header) => header.name.toLowerCase() === 'content-type')?.value ?? 'text/plain; charset=utf-8';
  const bodyEncoding = moved.find((header) => header.name.toLowerCase() === 'content-transfer-encoding');
  const parts = [renderPart([{ name: 'Content-Type', value: bodyType }, ...(bodyEncoding ? [bodyEncoding] : [])], body)];
  for (const attachment of attachments) {
    if (!Buffer.isBuffer(attachment.content) || !attachment.filename || !attachment.contentType) {
      throw attachmentError('attachment_invalid');
    }
    parts.push(renderPart([
      { name: 'Content-Type', value: `${attachment.contentType}; name="${attachment.filename}"` },
      { name: 'Content-Transfer-Encoding', value: 'base64' },
      { name: 'Content-Disposition', value: `attachment; filename="${attachment.filename}"` }
    ], wrapBase64(attachment.content)));
  }
  const headerBlock = kept.map((header) => `${header.name}: ${header.value}`).join('\r\n');
  return `${headerBlock}\r\n\r\n${parts.map((part) => `--${boundary}\r\n${part}`).join('')}--${boundary}--\r\n`;
}
