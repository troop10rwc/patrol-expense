import type { NoticeSendStatus } from "../shared/types.ts";
import { STATUS_FOR_EVENT, rankStatus } from "./mail.ts";

// Delivery lifecycle for sent notices.
//
// Cloudflare Email Sending publishes cf.email.sending.message.* events to a
// queue (see the `queues.consumers` block in wrangler.jsonc); this folds them
// into notice_sends so the Reimbursement tab can say "delivered" or "bounced"
// instead of just "we pressed send".
//
// Two properties the queue does NOT give us, and which shape everything below:
// delivery is at-least-once (so the same event can arrive twice) and unordered
// (so a `deferred` can land after the `delivered` that superseded it).

/** The event envelope, as much of it as we rely on. */
interface EmailEventBody {
  type?: string;
  payload?: {
    eventId?: string;
    messageId?: string;
    recipient?: string;
    terminal?: boolean;
    [k: string]: unknown;
  };
  metadata?: { timestamp?: string };
}

/**
 * Dig a human-readable failure reason out of a payload whose exact shape varies
 * by event type (bounce vs rejection vs internal failure).
 */
function failureDetail(payload: Record<string, unknown> | undefined): { code: string | null; detail: string | null } {
  if (!payload) return { code: null, detail: null };
  const nested = ["delivery", "bounce", "rejection", "failure", "error"]
    .map((k) => payload[k])
    .find((v): v is Record<string, unknown> => !!v && typeof v === "object");
  const pick = (obj: Record<string, unknown> | undefined, keys: string[]): string | null => {
    for (const k of keys) {
      const v = obj?.[k];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
    return null;
  };
  return {
    code: pick(nested, ["code", "status", "errorCause"]) ?? pick(payload, ["errorCause", "code"]),
    detail:
      pick(nested, ["reason", "message", "description", "errorDetail"]) ??
      pick(payload, ["errorDetail", "reason", "message"]),
  };
}

/**
 * Apply one event. Returns false if it was unrecognizable — the caller acks
 * those rather than retrying, since replaying them would never help.
 */
export async function applyEmailEvent(db: D1Database, body: EmailEventBody): Promise<boolean> {
  const type = body.type ?? "";
  const status = STATUS_FOR_EVENT[type];
  const messageId = body.payload?.messageId;
  if (!status || !messageId) return false;

  const occurredAt = body.metadata?.timestamp ?? new Date().toISOString();
  const terminal = body.payload?.terminal === true ? 1 : 0;
  const { code, detail } = failureDetail(body.payload);

  const send = await db
    .prepare("SELECT id, status FROM notice_sends WHERE message_id = ?")
    .bind(messageId)
    .first<{ id: number; status: NoticeSendStatus }>();

  // Logged even when no send row matches: an event can beat its own send row to
  // the database, and a lost bounce is exactly what this feature must not do.
  // INSERT OR IGNORE against the (message_id, type, occurred_at) index makes a
  // redelivered event a no-op.
  await db
    .prepare(
      `INSERT OR IGNORE INTO notice_send_events (send_id, message_id, type, occurred_at, terminal, detail)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(send?.id ?? null, messageId, type, occurredAt, terminal, JSON.stringify(body.payload ?? {}).slice(0, 2000))
    .run();

  if (!send) return true;

  // Only ever move forward. An out-of-order `deferred` must not un-deliver a
  // message, and a duplicate must not rewrite a status that already advanced.
  if (rankStatus(status) <= rankStatus(send.status)) return true;

  await db
    .prepare(
      `UPDATE notice_sends
          SET status = ?,
              status_at = ?,
              delivered_at = CASE WHEN ? = 'delivered' THEN ? ELSE delivered_at END,
              error_code = COALESCE(?, error_code),
              error_detail = COALESCE(?, error_detail)
        WHERE id = ?`,
    )
    .bind(status, occurredAt, status, occurredAt, code, detail?.slice(0, 500) ?? null, send.id)
    .run();
  return true;
}

/**
 * Queue consumer. Each message is acked or retried on its own so one poisoned
 * event can't hold up a batch that also contains a bounce someone needs to see.
 */
export async function handleEmailEvents(batch: MessageBatch, db: D1Database): Promise<void> {
  for (const msg of batch.messages) {
    try {
      await applyEmailEvent(db, msg.body as EmailEventBody);
      msg.ack();
    } catch (e) {
      console.error("email event failed", e);
      msg.retry();
    }
  }
}
