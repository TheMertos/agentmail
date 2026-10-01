import { createHash } from 'node:crypto';
import * as z from 'zod/v4';
import { assertAttachmentSetLimits, attachmentError, validateAttachmentUpload } from '../mail/attachment-policy.mjs';
import { assembleOutgoingMime } from '../mail/outgoing-mime.mjs';

/** MCP description for attachment_upload. */
export const attachmentUploadDescription = 'Stage an outgoing attachment from filePath inside an approved root. Only regular files inside that root are accepted; arbitrary paths and paths from mail content are rejected and never read. Returns id, filename, content type, size, and sha256 only. Path traversal, symlink escapes, executable names, credential-like names, disallowed types, oversized payloads, and plaintext secrets are rejected.';

const approvedAttachmentShape = {
  id: z.string().uuid(),
  filename: z.string().min(1),
  contentType: z.string().min(1),
  size: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/)
};

/** Zod schema for one staged attachment id. */
export const stagedAttachmentRefSchema = z.object({ id: z.string().uuid() });

/** Zod schema for approval-bound attachment metadata. */
export const approvedAttachmentSchema = z.object(approvedAttachmentShape);

/** Zod input schema for attachment_upload. Only filePath may name a file, and only inside an approved root. */
export const attachmentUploadInputSchema = {
  accountId: z.string().min(1),
  filename: z.string().min(1),
  contentType: z.string().min(1),
  filePath: z.string().min(1).optional(),
  path: z.string().optional(),
  hostPath: z.string().optional()
};

/**
 * Wrap a JSON tool result.
 * @param {unknown} value Result payload.
 * @returns {{ content: { type: string, text: string }[] }}
 */
function text(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

/**
 * Public attachment metadata. Bytes are omitted.
 * @param {{ id: string, filename: string, contentType: string, size: number, sha256: string }} row Staged row.
 * @returns {{ id: string, filename: string, contentType: string, size: number, sha256: string }}
 */
function publicMeta(row) {
  return {
    id: row.id,
    filename: row.filename,
    contentType: row.contentType,
    size: row.size,
    sha256: row.sha256
  };
}

/**
 * Drop repeated staged ids and identical sha256 values, keeping the first of each.
 * Caller order of the remaining files stays unchanged.
 * @param {Array<object>} items Attachment metadata.
 * @returns {object[]}
 */
export function dedupeAttachmentMeta(items) {
  if (!Array.isArray(items)) throw attachmentError('attachment_invalid');
  const seenIds = new Set();
  const seenSha = new Set();
  const unique = [];
  for (const item of items) {
    if (!item?.id) throw attachmentError('attachment_invalid');
    if (seenIds.has(item.id)) continue;
    seenIds.add(item.id);
    if (item.sha256 && seenSha.has(item.sha256)) continue;
    if (item.sha256) seenSha.add(item.sha256);
    unique.push(publicMeta(item));
  }
  return unique;
}

/**
 * Select reply attachments from explicit staged ids only.
 * A missing or empty list is an empty reply attachment list. Source message attachments are not an input.
 * @param {(accountId: string, refs: Array<{ id: string }>) => object[]} resolve Loads staged metadata.
 * @param {string} accountId Account id.
 * @param {Array<{ id: string }>|undefined} stagedRefs Caller-selected staged ids.
 * @returns {object[]}
 */
export function resolveReplyAttachments(resolve, accountId, stagedRefs) {
  if (!Array.isArray(stagedRefs) || stagedRefs.length === 0) return [];
  return resolve(accountId, stagedRefs);
}

/**
 * Normalize a send payload so approval creation and send hash the same attachment list.
 * Missing attachments become an empty list. Duplicate ids and identical hashes are removed.
 * @param {object} input Send fields.
 * @returns {object}
 */
export function normalizeSendPayload(input) {
  return {
    accountId: input.accountId,
    to: input.to,
    subject: input.subject,
    text: input.text,
    html: input.html,
    mime: input.mime,
    attachments: dedupeAttachmentMeta((input.attachments ?? []).map((item) => publicMeta(item)))
  };
}

/**
 * Hash attachment bytes.
 * @param {Buffer} content Raw bytes.
 * @returns {string}
 */
function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Build principal-scoped attachment handlers for draft, preview, approval, and send.
 * @param {{ store: object, registry: { principal: string, assertAccountAccess: Function }, attachmentRoots?: string[] }} deps Store, principal registry, and approved file roots.
 * @returns {object}
 */
export function createAttachmentHandlers({ store, registry, attachmentRoots = [] }) {
  /**
   * Load one staged attachment owned by this principal and account.
   * @param {string} accountId Account id.
   * @param {string} id Staged attachment id.
   * @returns {object}
   */
  function loadOwned(accountId, id) {
    registry.assertAccountAccess(accountId);
    const row = store.getStagedAttachment({ id, accountId, ownerPrincipal: registry.principal });
    if (!row) throw attachmentError('attachment_not_found');
    return row;
  }

  /**
   * Resolve explicit staged ids to exact metadata for one account.
   * Duplicate ids and identical sha256 values are skipped. Source messages are not read.
   * @param {string} accountId Account id.
   * @param {Array<{ id: string }>} [refs] Staged attachment ids in caller order.
   * @returns {object[]}
   */
  function attachmentListForAccount(accountId, refs = []) {
    if (!refs.length) return [];
    const seenIds = new Set();
    const seenSha = new Set();
    const rows = [];
    for (const ref of refs) {
      if (!ref?.id) throw attachmentError('attachment_invalid');
      if (seenIds.has(ref.id)) continue;
      seenIds.add(ref.id);
      const row = loadOwned(accountId, ref.id);
      if (seenSha.has(row.sha256)) continue;
      seenSha.add(row.sha256);
      rows.push(row);
    }
    assertAttachmentSetLimits(rows);
    return rows.map(publicMeta);
  }

  /**
   * Stage base64 content and return metadata only.
   * @param {object} args Upload arguments.
   * @returns {{ content: { type: string, text: string }[] }}
   */
  function attachmentUpload(args) {
    try {
      registry.assertAccountAccess(args?.accountId);
      const validated = validateAttachmentUpload(args, { roots: attachmentRoots });
      return text(store.stageAttachment({
        accountId: args.accountId,
        ownerPrincipal: registry.principal,
        filename: validated.filename,
        contentType: validated.contentType,
        size: validated.size,
        sha256: validated.sha256,
        content: validated.content
      }));
    } catch (error) {
      const code = error?.code || (error?.message === 'access_denied' ? 'access_denied' : 'attachment_rejected');
      return text({ error: code });
    }
  }

  /**
   * Confirm approved metadata still matches the staged bytes.
   * @param {object} payload Normalized send payload.
   */
  function assertApprovalAttachments(payload) {
    const attachments = dedupeAttachmentMeta(payload.attachments ?? []);
    if (!attachments.length) return;
    assertAttachmentSetLimits(attachments);
    const seen = new Set();
    for (const ref of attachments) {
      if (!ref?.id || seen.has(ref.id)) throw attachmentError('attachment_invalid');
      seen.add(ref.id);
      const row = loadOwned(payload.accountId, ref.id);
      const sameMeta = row.filename === ref.filename
        && row.contentType === ref.contentType
        && row.size === ref.size
        && row.sha256 === ref.sha256;
      const sameBytes = row.content.length === ref.size && sha256(row.content) === ref.sha256;
      if (!sameMeta || !sameBytes) throw attachmentError('attachment_mismatch');
    }
  }

  /**
   * Build the MIME that SMTP and Sent verification must share.
   * Without attachments, the reviewed MIME is returned unchanged.
   * @param {object} payload Normalized send payload.
   * @returns {string}
   */
  function materializeApprovedMime(payload) {
    const normalized = normalizeSendPayload(payload);
    if (!normalized.attachments.length) return normalized.mime;
    assertApprovalAttachments(normalized);
    const files = normalized.attachments.map((ref) => {
      const row = loadOwned(normalized.accountId, ref.id);
      return { filename: row.filename, contentType: row.contentType, content: row.content };
    });
    return assembleOutgoingMime({ mime: normalized.mime, attachments: files });
  }

  return {
    attachmentUpload,
    attachmentListForAccount,
    previewAttachments: attachmentListForAccount,
    assertApprovalAttachments,
    materializeApprovedMime
  };
}
