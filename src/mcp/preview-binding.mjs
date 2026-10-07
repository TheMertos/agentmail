import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { createApproval } from '../core/approval.mjs';
import { composeOutgoingMessage } from '../core/compose-message.mjs';
import { createAttachmentHandlers, normalizeSendPayload, resolveReplyAttachments } from './attachment-tools.mjs';
import { normalizeRecipientList, sameRecipientList } from '../mail/recipients.mjs';
import { resolveReplyTarget } from '../mail/reply-target.mjs';

const { simpleParser } = createRequire(import.meta.url)('mailparser');

/**
 * Wrap a JSON tool result.
 * @param {unknown} value Result payload.
 * @returns {{ content: { type: string, text: string }[] }}
 */
function text(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

/**
 * Compare attachment metadata in order.
 * @param {object[]} expected Preview attachment metadata.
 * @param {object[]} actual Approval attachment metadata.
 * @returns {boolean}
 */
function sameAttachments(expected, actual) {
  const left = expected ?? [];
  const right = actual ?? [];
  if (left.length !== right.length) return false;
  return left.every((item, index) => {
    const other = right[index];
    return item.id === other?.id
      && item.filename === other.filename
      && item.contentType === other.contentType
      && item.size === other.size
      && item.sha256 === other.sha256;
  });
}

/**
 * True when the send payload is the exact preview for this principal.
 * Cc and Bcc must match the preview. The reviewed MIME body must contain the preview text and HTML literally.
 * @param {{ accountId: string, principal: string, text: string, html: string, cc?: string[], bcc?: string[], attachments?: object[] }} binding Stored preview binding.
 * @param {{ accountId: string, text: string, html: string, mime: string, attachments?: object[] }} payload Normalized send payload.
 * @param {string} principal Runtime principal.
 * @returns {boolean}
 */
export function matchesPreviewBinding(binding, payload, principal) {
  if (!binding || binding.principal !== principal) return false;
  if (binding.accountId !== payload?.accountId) return false;
  if (binding.text !== payload.text || binding.html !== payload.html) return false;
  if (!sameAttachments(binding.attachments, payload.attachments)) return false;
  if (!sameRecipientList(binding.cc, payload.cc) || !sameRecipientList(binding.bcc, payload.bcc)) return false;
  if (typeof payload.mime !== 'string') return false;
  const bodyBreak = payload.mime.indexOf('\r\n\r\n');
  if (bodyBreak === -1) return false;
  const body = payload.mime.slice(bodyBreak + 4);
  return body.includes(binding.text) && body.includes(binding.html);
}

/**
 * Map an attachment or access failure to a tool error code.
 * @param {Error & { code?: string }} error Thrown error.
 * @returns {string}
 */
function attachmentFailure(error) {
  return error?.code || (error?.message === 'access_denied' ? 'access_denied' : 'attachment_rejected');
}

/**
 * Encode a non-ASCII subject as a UTF-8 RFC 2047 encoded-word.
 * ASCII subjects remain readable and unchanged.
 * @param {string} subject Subject value.
 * @returns {string}
 */
function encodeSubject(subject) {
  if (/^[\x00-\x7F]*$/.test(subject)) return subject;
  return `=?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`;
}

/**
 * Format one address header when the list is non-empty.
 * An empty Cc or Bcc list omits the header so To-only messages stay unchanged.
 * @param {string} name Header name.
 * @param {string[]} addresses Normalized addresses.
 * @returns {string[]}
 */
function addressHeader(name, addresses) {
  if (!addresses?.length) return [];
  return [`${name}: ${addresses.join(', ')}`];
}

/**
 * Build the exact reviewed MIME from the preview bodies and envelope fields.
 * @param {{ email?: string }} account Account metadata.
 * @param {string[]} to To recipients.
 * @param {string[]} cc Cc recipients.
 * @param {string[]} bcc Bcc recipients.
 * @param {string} subject Subject.
 * @param {string} bodyText Exact preview text.
 * @param {string} bodyHtml Exact preview HTML.
 * @param {{ inReplyTo?: string, references?: string[] }|null} [replyHeaders] Reply header fields.
 * @returns {string}
 */
function buildPreviewMime(account, to, cc, bcc, subject, bodyText, bodyHtml, replyHeaders = null) {
  const boundary = `agentmail_preview_${randomUUID()}`;
  const headers = [
    `From: ${account?.email ?? ''}`,
    `To: ${to.join(', ')}`,
    ...addressHeader('Cc', cc),
    ...addressHeader('Bcc', bcc),
    `Subject: ${encodeSubject(subject)}`,
    'MIME-Version: 1.0',
    ...(replyHeaders?.inReplyTo ? [`In-Reply-To: ${replyHeaders.inReplyTo}`] : []),
    ...(Array.isArray(replyHeaders?.references) && replyHeaders.references.length
      ? [`References: ${replyHeaders.references.join(' ')}`]
      : []),
    `Content-Type: multipart/alternative; boundary="${boundary}"`
  ];
  return [
    ...headers,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    bodyText,
    `--${boundary}`,
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    bodyHtml,
    `--${boundary}--`,
    ''
  ].join('\r\n');
}

/**
 * Reduce parsed source HTML to embeddable body content.
 * Document wrappers, head metadata, and style or script blocks are removed.
 * Nested quotes inside the body stay intact.
 * @param {string} html Parsed source HTML document or fragment.
 * @returns {string} Quote fragment.
 */
function normalizeSourceQuoteHtml(html) {
  let result = html
    .replace(/<!DOCTYPE[^>]*>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, '')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/?(?:meta|link|title|base)\b[^>]*>/gi, '');
  const body = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(result);
  if (body) result = body[1];
  return result.replace(/<\/?(?:html|body|head)\b[^>]*>/gi, '').trim();
}

/**
 * Read the complete plain and HTML bodies from a peeked source message.
 * Caller snippets are not accepted as a substitute.
 * @param {object} message Peeked source message.
 * @returns {Promise<{ quoteText: string, quoteHtml?: string }>} Full source quote parts.
 */
async function completeSourceQuote(message) {
  const raw = message?.raw;
  if ((typeof raw !== 'string' && !Buffer.isBuffer(raw)) || raw.length === 0) {
    throw new Error('source_quote_unavailable');
  }
  let parsed;
  try {
    parsed = await simpleParser(raw, { skipHtmlToText: true, skipTextToHtml: true });
  } catch {
    throw new Error('source_quote_unavailable');
  }
  const quoteText = typeof parsed.text === 'string' ? parsed.text.replace(/\r\n/g, '\n').replace(/\s+$/, '') : '';
  const quoteHtml = typeof parsed.html === 'string' ? normalizeSourceQuoteHtml(parsed.html) : undefined;
  if (!quoteText && !quoteHtml) throw new Error('source_quote_unavailable');
  return { quoteText, quoteHtml };
}

/**
 * Build message_preview and send_approval_create handlers bound to one preview map.
 * Approval creation accepts only an unexpired preview for the same account and principal,
 * and only when text, HTML, Cc, Bcc, attachments, and MIME match that preview exactly.
 * @param {{ store: object, registry: { principal: string, assertAccountAccess: Function }, pendingPreviews: Map<string, object>, pendingApprovals: Map<string, object>, attachmentsApi?: object, now?: () => number, previewTtlSeconds?: number, approvalTtlSeconds?: number }} deps Store, principal registry, and pending maps.
 * @returns {{ messagePreview: Function, sendApprovalCreate: Function }}
 */
export function createPreviewBinding({
  store,
  registry,
  mailService = null,
  pendingPreviews,
  pendingApprovals,
  attachmentsApi = createAttachmentHandlers({ store, registry }),
  now = () => Math.floor(Date.now() / 1000),
  previewTtlSeconds = 300,
  approvalTtlSeconds = 300
}) {
  /**
   * Render the outgoing message and store a short-lived exact preview binding.
   * @param {object} args Preview tool arguments.
   * @returns {Promise<{ content: { type: string, text: string }[] }>}
   */
  async function messagePreview({ accountId, newText, newHtml, signatureId, quoteText, quoteHtml, quoteDepth, sourceMessageKey, replyMode = 'reply', attachments, cc, bcc }) {
    try {
      registry.assertAccountAccess(accountId);
    } catch {
      return text({ error: 'access_denied' });
    }
    let normalizedCc;
    let normalizedBcc;
    try {
      normalizedCc = normalizeRecipientList(cc);
      normalizedBcc = normalizeRecipientList(bcc);
    } catch {
      return text({ error: 'recipients_invalid' });
    }
    let signature;
    try {
      signature = store.resolveSignatureForSend({ accountId, explicitId: signatureId });
    } catch (error) {
      return text({ error: error.message });
    }
    let replyTarget = null;
    let resolvedQuoteText = quoteText;
    let resolvedQuoteHtml = quoteHtml;
    if (sourceMessageKey) {
      try {
        if (typeof mailService?.peekMessage !== 'function') return text({ error: 'provider_unavailable' });
        const message = await mailService.peekMessage(sourceMessageKey);
        if (!message) return text({ error: 'source_message_not_found' });
        replyTarget = resolveReplyTarget({ message, accountId, sourceMessageKey, mode: replyMode });
        const sourceQuote = await completeSourceQuote(message);
        resolvedQuoteText = sourceQuote.quoteText;
        resolvedQuoteHtml = sourceQuote.quoteHtml;
      } catch (error) {
        return text({ error: error.message });
      }
    }
    const composed = composeOutgoingMessage({
      newText,
      newHtml,
      signature,
      quoteText: resolvedQuoteText,
      quoteHtml: resolvedQuoteHtml,
      quoteDepth
    });
    let replyAttachments;
    try {
      replyAttachments = resolveReplyAttachments(
        (id, refs) => attachmentsApi.previewAttachments(id, refs),
        accountId,
        attachments
      );
    } catch (error) {
      return text({ error: attachmentFailure(error) });
    }
    const preview = {
      id: randomUUID(),
      accountId,
      principal: registry.principal,
      text: composed.text,
      html: composed.html,
      signature: signature ? { id: signature.id, name: signature.name, version: signature.version } : null,
      quoteText: resolvedQuoteText ?? '',
      quoteHtml: resolvedQuoteHtml ?? '',
      sourceMessageKey: sourceMessageKey ?? null,
      replyHeaders: replyTarget ? {
        inReplyTo: replyTarget.headers.inReplyTo,
        references: replyTarget.headers.references
      } : null,
      attachments: replyAttachments,
      cc: normalizedCc,
      bcc: normalizedBcc,
      expiresAt: now() + previewTtlSeconds
    };
    pendingPreviews.set(preview.id, preview);
    return text({
      previewId: preview.id,
      text: preview.text,
      html: preview.html,
      signature: preview.signature,
      attachments: preview.attachments,
      cc: preview.cc,
      bcc: preview.bcc,
      expiresAt: preview.expiresAt
    });
  }

  /**
   * Create a send approval only for the exact stored preview.
   * Missing, expired, cross-account, cross-principal, or edited bodies are rejected.
   * @param {object} args Approval tool arguments.
   * @returns {Promise<{ content: { type: string, text: string }[] }>}
   */
  async function sendApprovalCreate({ previewId, accountId, to, cc, bcc, subject, text: bodyText, html, mime, attachments } = {}) {
    if (!previewId) return text({ error: 'preview_required' });
    const preview = pendingPreviews.get(previewId);
    if (!preview || !Number.isInteger(preview.expiresAt) || now() > preview.expiresAt || preview.principal !== registry.principal) {
      return text({ error: 'preview_invalid_or_expired' });
    }
    try {
      registry.assertAccountAccess(accountId);
    } catch {
      return text({ error: 'access_denied' });
    }
    let toList;
    let ccList;
    let bccList;
    try {
      toList = normalizeRecipientList(to, { required: true });
      ccList = normalizeRecipientList(cc);
      bccList = normalizeRecipientList(bcc);
    } catch {
      return text({ error: 'recipients_invalid' });
    }
    if (preview.accountId !== accountId || typeof subject !== 'string'
      || !sameRecipientList(preview.cc, ccList) || !sameRecipientList(preview.bcc, bccList)) {
      return text({ error: 'preview_invalid_or_expired' });
    }
    const previewAttachments = preview.attachments ?? [];
    const payload = normalizeSendPayload({
      accountId,
      to: toList,
      cc: ccList,
      bcc: bccList,
      subject,
      text: preview.text,
      html: preview.html,
      mime: buildPreviewMime(registry.get(accountId), toList, ccList, bccList, subject, preview.text, preview.html, preview.replyHeaders),
      attachments: previewAttachments
    });
    // Legacy callers may still provide copied bodies, but they can never replace the preview.
    if ((bodyText !== undefined && bodyText !== preview.text)
      || (html !== undefined && html !== preview.html)
      || (mime !== undefined && !matchesPreviewBinding(preview, { ...payload, mime }, registry.principal))
      || (attachments !== undefined && !sameAttachments(previewAttachments, attachments))
      || (attachments === undefined && previewAttachments.length > 0 && (bodyText !== undefined || html !== undefined || mime !== undefined))) {
      return text({ error: 'preview_invalid_or_expired' });
    }
    try {
      attachmentsApi.assertApprovalAttachments(payload);
    } catch (error) {
      return text({ error: attachmentFailure(error) });
    }
    const approval = createApproval(payload, { ttlSeconds: approvalTtlSeconds, now: now() });
    pendingApprovals.set(approval.id, {
      approval,
      payload,
      principal: registry.principal,
      previewBinding: {
        accountId: preview.accountId,
        principal: preview.principal,
        text: preview.text,
        html: preview.html,
        cc: [...(preview.cc ?? [])],
        bcc: [...(preview.bcc ?? [])],
        attachments: previewAttachments.map((item) => ({ ...item }))
      }
    });
    return text(approval);
  }

  return { messagePreview, sendApprovalCreate };
}
