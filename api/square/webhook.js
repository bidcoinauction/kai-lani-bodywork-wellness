import { isBookingApprovalEnabled } from "../../lib/approval-config.js";
import { WebhooksHelper } from "../../lib/square.js";
import { readRawBody } from "../../lib/read-raw-body.js";
import { getQStashPublisher, QSTASH_PUBLISH_TIMEOUT_MS } from "../../lib/qstash-publisher.js";
import {
  buildSquareWebhookQueueMessage,
  SquareWebhookMessageError,
  SUPPORTED_SQUARE_BOOKING_EVENTS,
} from "../../lib/square-webhook-message.js";
import { SQUARE_RETRIEVE_TIMEOUT_SECONDS } from "../../lib/square-webhook-reconcile.js";

function bookingSuffix(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.:-]{1,120}$/.test(value)) return "";
  return value.slice(-6);
}

function logIntake(stage, eventType = "", bookingId = "", startedAt = Date.now(), errorCode = null) {
  console.info(
    `webhook-intake stage=${stage} eventType=${eventType} bookingSuffix=${bookingSuffix(bookingId)} elapsedMs=${Date.now() - startedAt}${errorCode ? ` error=${errorCode}` : ""}`,
  );
}

export default async function handler(req, res) {
  const startedAt = Date.now();
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!isBookingApprovalEnabled()) {
    return res.status(503).json({ error: "Square webhook processing is not available right now." });
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

  const eventType = typeof event.type === "string" ? event.type : "";
  if (!SUPPORTED_SQUARE_BOOKING_EVENTS.has(eventType)) {
    return res.status(200).json({ received: true, ignored: true });
  }

  let message;
  try {
    message = buildSquareWebhookQueueMessage(event);
  } catch (error) {
    const code = error instanceof SquareWebhookMessageError ? error.code : "invalid_payload";
    logIntake("rejected", eventType, "", startedAt, code);
    return res.status(400).json({ error: "Invalid payload" });
  }

  const publisher = getQStashPublisher();
  if (!publisher) {
    logIntake("failed", eventType, message.bookingId, startedAt, "qstash_not_configured");
    return res.status(503).json({ error: "Queue is not configured" });
  }

  try {
    const published = await publisher.publishSquareWebhook(message);
    logIntake(
      published?.deduplicated ? "deduplicated" : "published",
      eventType,
      message.bookingId,
      startedAt,
    );
    return res.status(202).json({ received: true, queued: true });
  } catch (error) {
    const code = error?.name === "AbortError" ? "qstash_publish_timeout" : "qstash_publish_failed";
    const status = Number.isInteger(error?.status) && error.status >= 100 && error.status <= 599 ? String(error.status) : "";
    logIntake("failed", eventType, message.bookingId, startedAt, code + (status ? ` status=${status}` : ""));
    return res.status(503).json({ error: "Could not queue Square webhook right now." });
  }
}

export const webhookTestInternals = {
  SUPPORTED_EVENTS: SUPPORTED_SQUARE_BOOKING_EVENTS,
  SQUARE_RETRIEVE_TIMEOUT_SECONDS,
  QSTASH_PUBLISH_TIMEOUT_MS,
  buildSquareWebhookQueueMessage,
};
