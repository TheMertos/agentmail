import { verifyApproval } from '../core/approval.mjs';
import { redactToolError, redactValue } from '../security/redact.mjs';
import { createAttachmentHandlers, normalizeSendPayload } from './attachment-tools.mjs';
import { matchesPreviewBinding } from './preview-binding.mjs';

/**
 * Wrap a JSON tool result.
 * @param {unknown} value Result payload.
 * @returns {{ content: { type: string, text: string }[] }}
 */
function text(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

/**
 * Compare approved and requested recipients in order.
 * @param {string[]} approved Recipients bound to the approval.
 * @param {string[]} requested Recipients on the send request.
 * @returns {boolean}
 */
function sameRecipients(approved, requested) {
  if (!Array.isArray(approved) || !Array.isArray(requested) || approved.length !== requested.length) return false;
  return approved.every((recipient, index) => recipient === requested[index]);
}

/**
 * Build the message_send tool handler.
 * SMTP runs only after account, principal, recipient, and attachment checks agree.
 * @param {{ pendingApprovals: Map<string, { approval: object, payload: object, principal: string, previewBinding?: object }>, registry: { principal: string, assertAccountAccess: Function }, store: object, now?: () => number }} deps Approval map, principal registry, and store.
 * @returns {(args: object, mailService: { sendMime: Function }) => Promise<{ content: { type: string, text: string }[] }>}
 */
export function createMessageSendHandler({ pendingApprovals, registry, store, now = () => Math.floor(Date.now() / 1000) }) {
  const attachmentsApi = createAttachmentHandlers({ store, registry });

  /**
   * Send one approved payload, or return a fail-closed error code.
   * @param {object} args Tool arguments including approvalId.
   * @param {{ sendMime: Function }} mailService SMTP and Sent sender.
   * @returns {Promise<{ content: { type: string, text: string }[] }>}
   */
  return async function messageSend({ approvalId, ...rawPayload }, mailService) {
    const entry = pendingApprovals.get(approvalId);
    if (!entry?.approval || !entry.payload) return text({ error: 'approval_not_found' });
    const supplied = Object.keys(rawPayload).length > 0;
    const candidate = normalizeSendPayload({ ...entry.payload, ...rawPayload });
    const payload = entry.payload;
    try {
      registry.assertAccountAccess(candidate.accountId);
    } catch {
      return text({ error: 'access_denied' });
    }
    if (entry.principal !== registry.principal) return text({ error: 'access_denied' });
    if (candidate.accountId !== payload.accountId
      || !sameRecipients(payload.to, candidate.to)
      || candidate.subject !== payload.subject) {
      return text({ error: 'approval_invalid_or_expired' });
    }
    if (supplied && entry.previewBinding && !matchesPreviewBinding(entry.previewBinding, candidate, registry.principal)) {
      return text({ error: 'approval_invalid_or_expired' });
    }
    if (supplied && !entry.previewBinding && !verifyApproval(entry.approval, candidate, now())) {
      return text({ error: 'approval_invalid_or_expired' });
    }
    if (!verifyApproval(entry.approval, payload, now())) return text({ error: 'approval_invalid_or_expired' });
    if (entry.previewBinding && !matchesPreviewBinding(entry.previewBinding, payload, registry.principal)) {
      return text({ error: 'approval_invalid_or_expired' });
    }
    let mime;
    try {
      mime = attachmentsApi.materializeApprovedMime(payload);
    } catch (error) {
      const code = error?.code === 'attachment_mismatch' ? 'approval_invalid_or_expired' : redactToolError(error);
      return text({ error: code });
    }
    pendingApprovals.delete(approvalId);
    try {
      return text(redactValue(await mailService.sendMime(payload.accountId, mime)));
    } catch (error) {
      return text({ error: redactToolError(error) });
    }
  };
}
