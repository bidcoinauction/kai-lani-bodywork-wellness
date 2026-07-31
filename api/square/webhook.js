import { WebhooksHelper } from "../../lib/square.js";
import { readRawBody } from "../../lib/read-raw-body.js";

/**
 * Sandbox-only event-id dedupe.
 *
 * In-memory state does not survive cold starts and is not shared across Vercel
 * function instances, so duplicate webhooks can still reach processing during
 * sandbox testing. A durable datastore for idempotent event handling is a
 * launch blocker for production.
 */
const MAX_TRACKED_EVENTS = 1000;
const processedEventIds = new Set();

function markProcessed(eventId) {
  processedEventIds.add(eventId);
  if (processedEventIds.size > MAX_TRACKED_EVENTS) {
    const oldest = processedEventIds.values().next().value;
    processedEventIds.delete(oldest);
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const signature = req.headers["x-square-hmacsha256-signature"];
  const notificationUrl = process.env.SQUARE_WEBHOOK_NOTIFICATION_URL;
  const signatureKey = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY;

  if (!signature || !notificationUrl || !signatureKey) {
    return res.status(401).json({ error: "Invalid signature" });
  }

  const rawBody = await readRawBody(req);
  if (!rawBody) {
    return res.status(400).json({
      error: "Could not read the raw request body. Verify the platform does not pre-parse JSON bodies.",
    });
  }

  const isFromSquare = await WebhooksHelper.verifySignature({
    requestBody: rawBody,
    signatureHeader: signature,
    signatureKey,
    notificationUrl,
  });

  if (!isFromSquare) {
    return res.status(401).json({ error: "Invalid signature" });
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return res.status(400).json({ error: "Invalid payload" });
  }

  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return res.status(400).json({ error: "Invalid payload" });
  }

  const eventId = typeof event.event_id === "string" ? event.event_id : "";
  if (eventId && processedEventIds.has(eventId)) {
    console.info(`Webhook event status=duplicate eventId=${eventId}`);
    return res.status(200).json({ received: true, duplicate: true });
  }
  if (eventId) {
    markProcessed(eventId);
  }

  const eventType = typeof event.type === "string" ? event.type : "unknown";
  const bookingId =
    typeof event.data?.object?.booking?.id === "string"
      ? event.data.object.booking.id
      : "";

  // SANDBOX STUB: event processing is intentionally a no-op until a durable
  // datastore is selected. Only safe operational metadata is logged.
  console.info(
    `Webhook event status=stub eventId=${eventId} type=${eventType}${bookingId ? ` bookingId=${bookingId}` : ""}`,
  );

  return res.status(200).json({ received: true });
}
