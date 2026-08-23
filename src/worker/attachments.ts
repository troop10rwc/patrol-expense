// Shared rules for files the app accepts and stores in R2 (the RECEIPTS
// bucket). Used by the authenticated expense-upload routes in index.ts and by
// the inbound mail handler, which takes photos straight off an email reply —
// both paths need the same limits, so they live here rather than in either one.

/** Images and PDFs, up to 10 MB each. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export const isAllowedAttachmentType = (type: string): boolean =>
  type.startsWith("image/") || type === "application/pdf";

export function validateAttachment(file: File): string | null {
  if (!isAllowedAttachmentType(file.type))
    return `Unsupported file type: ${file.type || "unknown"} (images and PDFs only)`;
  if (file.size === 0) return `Empty file: ${file.name}`;
  if (file.size > MAX_ATTACHMENT_BYTES) return `File too large: ${file.name} (max 10 MB)`;
  return null;
}

/** Sanitize for use in an R2 key and a Content-Disposition filename. */
export function safeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "file";
  return base.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "file";
}
