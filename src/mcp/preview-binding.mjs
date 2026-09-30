import { randomUUID } from 'node:crypto';
import { createApproval } from '../core/approval.mjs';
import { composeOutgoingMessage } from '../core/compose-message.mjs';
import { createAttachmentHandlers, normalizeSendPayload, resolveReplyAttachments } from './attachment-tools.mjs';

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
 * The reviewed MIME body must contain the preview text and HTML literally.
 * @param {{ accountId: string, principal: string, text: string, html: string, attachments?: object[] }} binding Stored preview binding.
 * @param {{ accountId: string, text: string, html: string, mime: string, attachments?: object[] }} payload Normalized send payload.
 * @param {string} principal Runtime principal.
 * @returns {boolean}
 */
export function matchesPreviewBinding(binding, payload, principal) {
  if (!binding || binding.principal !== principal) return false;
  if (binding.accountId !== payload?.accountId) return false;
  if (binding.text !== payload.text || binding.html !== payload.html) return false;
  if (!sameAttachments(binding.attachments, payload.attachments)) return false;
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
 * Build the exact reviewed MIME from the preview bodies and envelope fields.
 * @param {{ email?: string }} account Account metadata.
 * @param {string[]} to Recipients.
 * @param {string} subject Subject.
 * @param {string} bodyText Exact preview text.
 * @param {string} bodyHtml Exact preview HTML.
 * @returns {string}
 */
function buildPreviewMime(account, to, subject, bodyText, bodyHtml) {
  const boundary = `agentmail_preview_${randomUUID()}`;
  return [
    `From: ${account?.email ?? ''}`,
    `To: ${to.join(', ')}`,
    `Subject: ${encodeSubject(subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
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
 * Build message_preview and send_approval_create handlers bound to one preview map.
 * Approval creation accepts only an unexpired preview for the same account and principal,
 * and only when text, HTML, attachments, and MIME match that preview exactly.
 * @param {{ store: object, registry: { principal: string, assertAccountAccess: Function }, pendingPreviews: Map<string, object>, pendingApprovals: Map<string, object>, attachmentsApi?: object, now?: () => number, previewTtlSeconds?: number, approvalTtlSeconds?: number }} deps Store, principal registry, and pending maps.
 * @returns {{ messagePreview: Function, sendApprovalCreate: Function }}
 */
export function createPreviewBinding({
  store,
  registry,
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
  async function messagePreview({ accountId, newText, newHtml, signatureId, quoteText, quoteHtml, quoteDepth, attachments }) {
    try {
      registry.assertAccountAccess(accountId);
    } catch {
      return text({ error: 'access_denied' });
    }
    let signature;
    try {
      signature = store.resolveSignatureForSend({ accountId, explicitId: signatureId });
    } catch (error) {
      return text({ error: error.message });
    }
    const composed = composeOutgoingMessage({ newText, newHtml, signature, quoteText, quoteHtml, quoteDepth });
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
      quoteText: quoteText ?? '',
      quoteHtml: quoteHtml ?? '',
      attachments: replyAttachments,
      expiresAt: now() + previewTtlSeconds
    };
    pendingPreviews.set(preview.id, preview);
    return text({
      previewId: preview.id,
      text: preview.text,
      html: preview.html,
      signature: preview.signature,
      attachments: preview.attachments,
      expiresAt: preview.expiresAt
    });
  }

  /**
   * Create a send approval only for the exact stored preview.
   * Missing, expired, cross-account, cross-principal, or edited bodies are rejected.
   * @param {object} args Approval tool arguments.
   * @returns {Promise<{ content: { type: string, text: string }[] }>}
   */
  async function sendApprovalCreate({ previewId, accountId, to, subject, text: bodyText, html, mime, attachments } = {}) {
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
    if (preview.accountId !== accountId || !Array.isArray(to) || !to.length || typeof subject !== 'string') {
      return text({ error: 'preview_invalid_or_expired' });
    }
    const previewAttachments = preview.attachments ?? [];
    const payload = normalizeSendPayload({
      accountId,
      to,
      subject,
      text: preview.text,
      html: preview.html,
      mime: buildPreviewMime(registry.get(accountId), to, subject, preview.text, preview.html),
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
        attachments: previewAttachments.map((item) => ({ ...item }))
      }
    });
    return text(approval);
  }

  return { messagePreview, sendApprovalCreate };
}
