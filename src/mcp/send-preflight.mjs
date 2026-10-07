import { verifyApproval } from '../core/approval.mjs';
import { redactToolError, redactValue } from '../security/redact.mjs';
import { createAttachmentHandlers, normalizeSendPayload } from './attachment-tools.mjs';
import { sameRecipientList } from '../mail/recipients.mjs';
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
 * Build the message_send tool handler.
 * SMTP runs only after account, principal, To/Cc/Bcc, and attachment checks agree.
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
    let candidate;
    try {
      candidate = normalizeSendPayload({ ...entry.payload, ...rawPayload });
    } catch (error) {
      if (error?.code === 'recipients_invalid') return text({ error: 'approval_invalid_or_expired' });
      throw error;
    }
    const payload = entry.payload;
    try {
      registry.assertAccountAccess(candidate.accountId);
    } catch {
      return text({ error: 'access_denied' });
    }
    if (entry.principal !== registry.principal) return text({ error: 'access_denied' });
    if (candidate.accountId !== payload.accountId
      || !sameRecipientList(payload.to, candidate.to)
      || !sameRecipientList(payload.cc, candidate.cc)
      || !sameRecipientList(payload.bcc, candidate.bcc)
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
