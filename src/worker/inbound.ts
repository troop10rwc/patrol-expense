import PostalMime, { type Attachment } from "postal-mime";
import { tokenFromReplyAddress } from "./mail.ts";
import { MAX_ATTACHMENT_BYTES, isAllowedAttachmentType, safeFilename } from "./attachments.ts";

// Replies to a reimbursement notice, routed back into the corrections queue.
//
// Notices go out with Reply-To: r+<statement token>@<REPLY_DOMAIN>, a catch-all
// Email Routing subdomain pointed at this Worker. A parent who hits Reply and
// writes "that gas receipt isn't mine" lands in the same review queue as the
// statement page's form — which is what keeps sending from the app as
// answerable as the old copy-and-paste flow was.
//
// Like the form, this is INERT: it files a claim and never touches an expense.

export interface InboundBindings {
  DB: D1Database;
  RECEIPTS: R2Bucket;
  MAIL_FALLBACK?: string;
}

/** Enough for a real message; a 40-message thread is quoting, not writing. */
const MAX_BODY_CHARS = 8000;
const MAX_ATTACHMENTS = 5;
/** Below this, an image is a signature logo or a spacer, not a receipt photo. */
const MIN_PHOTO_BYTES = 4 * 1024;

/**
 * Cut a reply down to what the person actually typed.
 *
 * Every mail client marks the quoted original differently and none of it is
 * structured, so this is a heuristic: find the earliest recognizable quote
 * marker and keep what precedes it. Getting it wrong only costs context — the
 * full thread is still in the treasurer's inbox via the fallback, and the
 * statement link in the correction points at the same frozen figures.
 */
export function stripQuotedReply(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let cut = lines.length;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Gmail/Apple attribution, which often wraps across two or three lines:
    // "On Mon, Aug 24, 2026 at 9:00 AM Troop 10 Expenses <expenses@...> wrote:"
    if (/^On\b/.test(line)) {
      const joined = [line, lines[i + 1] ?? "", lines[i + 2] ?? ""].join(" ");
      if (/\bwrote:\s*$/.test(line) || /\bwrote:/.test(joined)) { cut = i; break; }
    }
    // Outlook and friends.
    if (/^-{2,}\s*Original Message\s*-{2,}$/i.test(line)) { cut = i; break; }
    if (/^_{10,}$/.test(line)) { cut = i; break; }
    if (/^-{2,}\s*Forwarded message\s*-{2,}$/i.test(line)) { cut = i; break; }
    // Outlook's inline reply header block.
    if (/^From:\s/.test(line) && /^(Sent|To|Subject):\s/.test((lines[i + 1] ?? "").trim())) { cut = i; break; }
    // A run of quoted lines that continues to the end of the message.
    if (line.startsWith(">")) {
      const restIsQuoted = lines.slice(i).every((l) => l.trim() === "" || l.trim().startsWith(">"));
      if (restIsQuoted) { cut = i; break; }
    }
  }

  return lines.slice(0, cut).join("\n").trim();
}

/** Crude HTML -> text, for the rare reply that carries no text/plain part. */
function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<blockquote[\s\S]*$/i, "") // quoted original, in HTML replies
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n");
}

/**
 * Handle one inbound message.
 *
 * Every path must act on the message — forward, reject, or consume it. A handler
 * that just returns causes Cloudflare to drop the mail silently, which for a
 * parent disputing a bill is the worst possible outcome.
 */
export async function handleInboundEmail(
  message: ForwardableEmailMessage,
  env: InboundBindings,
): Promise<void> {
  // `message.to` is the envelope recipient (SMTP RCPT TO) and is trustworthy;
  // header addresses are not.
  const token = tokenFromReplyAddress(message.to);
  const link = token
    ? await env.DB.prepare(
        "SELECT token, trip_id, snapshot_id, person_id FROM statement_links WHERE token = ? AND revoked_at IS NULL",
      )
        .bind(token)
        .first<{ token: string; trip_id: number; snapshot_id: number; person_id: number }>()
    : null;

  // Mail we can't attribute — a bare address, a revoked link, a bounce report,
  // plain spam. Hand it to a human rather than swallowing it.
  if (!link) return forwardToFallback(message, env);

  const raw = await new Response(message.raw).arrayBuffer(); // single-use stream
  const parsed = await PostalMime.parse(raw);

  const rawBody = parsed.text?.trim() || (parsed.html ? htmlToText(parsed.html) : "");
  const body = stripQuotedReply(rawBody).slice(0, MAX_BODY_CHARS);
  const subject = (parsed.subject ?? "").slice(0, 300);
  const senderName = parsed.from?.name?.trim() || null;

  const inserted = await env.DB.prepare(
    `INSERT INTO corrections
       (trip_id, person_id, snapshot_id, kind, message, reporter_name, source, from_email, email_subject)
     VALUES (?, ?, ?, 'other', ?, ?, 'email', ?, ?)
     RETURNING id`,
  )
    .bind(
      link.trip_id,
      link.person_id,
      link.snapshot_id,
      body || "(the reply had no text — check any attached photos)",
      senderName,
      message.from,
      subject,
    )
    .first<{ id: number }>();
  if (!inserted) return forwardToFallback(message, env);

  await storeReplyAttachments(env, link.trip_id, inserted.id, parsed.attachments ?? []);
}

/** postal-mime hands back whichever representation the part was encoded in. */
function toBytes(content: string | ArrayBuffer | Uint8Array): Uint8Array {
  if (typeof content === "string") return new TextEncoder().encode(content);
  if (content instanceof Uint8Array) return content;
  return new Uint8Array(content);
}

/** The notice copy asks for "a photo of the receipt", so replies carry them. */
async function storeReplyAttachments(
  env: InboundBindings,
  tripId: number,
  correctionId: number,
  attachments: Attachment[],
): Promise<void> {
  let stored = 0;
  for (const att of attachments) {
    if (stored >= MAX_ATTACHMENTS) break;
    const type = att.mimeType ?? "";
    if (!isAllowedAttachmentType(type)) continue;

    const bytes = toBytes(att.content);
    const size = bytes.byteLength;
    if (size > MAX_ATTACHMENT_BYTES) continue;
    // Signature logos and spacer images ride along on almost every reply.
    if (type.startsWith("image/") && size < MIN_PHOTO_BYTES) continue;

    const filename = safeFilename(att.filename || `photo-${stored + 1}`);
    const key = `trip/${tripId}/correction/${correctionId}/${crypto.randomUUID()}-${filename}`;
    // Object first, so a committed row always points at real bytes.
    await env.RECEIPTS.put(key, bytes, { httpMetadata: { contentType: type } });
    await env.DB.prepare(
      "INSERT INTO correction_attachments (correction_id, trip_id, r2_key, filename, content_type, size) VALUES (?, ?, ?, ?, ?, ?)",
    )
      .bind(correctionId, tripId, key, filename, type, size)
      .run();
    stored++;
  }
}

async function forwardToFallback(message: ForwardableEmailMessage, env: InboundBindings): Promise<void> {
  if (!env.MAIL_FALLBACK) {
    // Nowhere to send it and nothing to file it against. Reject rather than
    // accept-and-drop, so the sender's own mail server tells them it failed.
    message.setReject("This address only accepts replies to Troop 10 expense notices.");
    return;
  }
  try {
    await message.forward(env.MAIL_FALLBACK, new Headers({ "X-Original-Recipient": message.to }));
  } catch (e) {
    // Forwarding only works to a VERIFIED destination address; an unverified one
    // fails here and the mail would vanish. Bounce it instead.
    console.error("inbound forward failed", e);
    message.setReject("Could not deliver this message.");
  }
}
