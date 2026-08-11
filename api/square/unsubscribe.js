import { isBookingApprovalEnabled } from "../../lib/approval-config.js";
import { getBookingRequestStore } from "../../lib/store.js";
import { hashToken } from "../../lib/tokens.js";
import { readRawBody } from "../../lib/read-raw-body.js";

const INVALID_LINK = "This unsubscribe link is invalid.";
const TOKEN_REQUIRED = "An unsubscribe token is required.";
const MAX_BODY_BYTES = 8 * 1024;

/**
 * /api/square/unsubscribe
 *
 * GET  ?token=...  read-only preference page (no private subscriber
 *                  information; email scanners that GET the link never cause
 *                  a mutation).
 * POST ?token=...  or { token }  performs the unsubscribe. The token may come
 *                  from the query string (RFC 8058 List-Unsubscribe=One-Click
 *                  sends the token in the URL) or the JSON body.
 *
 * Only the SHA-256 hash of the unsubscribe token is stored, the raw token is
 * never persisted, never returned, and never logged. No login is required
 * with a valid token, and the endpoint never returns the subscriber's email
 * address or any other private data.
 *
 * List-Unsubscribe / List-Unsubscribe-Post: One-Click are supported: future
 * marketing emails can point the List-Unsubscribe header at this endpoint.
 * No marketing email is sent by this task.
 */
export default async function handler(req, res) {
  if (!isBookingApprovalEnabled()) {
    return res
      .status(503)
      .json({ error: "Unsubscribe is not available right now." });
  }

  if (req.method === "GET") {
    return handlePreference(req, res);
  }
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  return handleUnsubscribe(req, res);
}

function tokenFromQuery(req) {
  const token = typeof req.query?.token === "string" ? req.query.token : "";
  return token.trim();
}

async function tokenFromBody(req) {
  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) {
    return typeof req.body.token === "string" ? req.body.token.trim() : "";
  }
  const raw = await readRawBody(req);
  if (!raw || Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) return "";
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed.token === "string" ? parsed.token.trim() : "";
  } catch {
    return "";
  }
}

function page(status) {
  const subscribed =
    status === "subscribed"
      ? "<p>You are subscribed to occasional wellness tips, studio updates and appointment offers from Kai Lani Bodywork &amp; Wellness.</p>"
      : "<p>You have been unsubscribed from marketing emails from Kai Lani Bodywork &amp; Wellness.</p>";
  return `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Email preferences</title></head>
  <body style="font-family: Arial, sans-serif; color: #1f2d2f; line-height: 1.5; max-width: 36rem; margin: 3rem auto; padding: 0 1rem;">
    <h1>Kai Lani Bodywork &amp; Wellness</h1>
    <h2>Email preferences</h2>
    ${subscribed}
  </body>
</html>`;
}

async function handlePreference(req, res) {
  const token = tokenFromQuery(req);
  if (!token) {
    return res.status(400).json({ error: TOKEN_REQUIRED });
  }

  const store = getBookingRequestStore();
  const subscription = await store.getSubscriptionByUnsubscribeTokenHash(hashToken(token));
  if (!subscription) {
    return res.status(404).json({ error: INVALID_LINK });
  }

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  return res.status(200).send(page(subscription.status));
}

async function handleUnsubscribe(req, res) {
  const queryToken = tokenFromQuery(req);
  const bodyToken = await tokenFromBody(req);
  const token = queryToken || bodyToken;
  if (!token) {
    return res.status(400).json({ error: TOKEN_REQUIRED });
  }

  const store = getBookingRequestStore();
  const hash = hashToken(token);

  const existing = await store.getSubscriptionByUnsubscribeTokenHash(hash);
  if (!existing) {
    return res.status(404).json({ error: INVALID_LINK });
  }
  if (existing.status === "unsubscribed") {
    // Idempotent: already unsubscribed.
    return res.status(200).json({ status: "unsubscribed" });
  }

  const updated = await store.unsubscribeByTokenHash(hash);
  if (!updated) {
    // Lost a race with another unsubscribe request; already unsubscribed.
    return res.status(200).json({ status: "unsubscribed" });
  }
  return res.status(200).json({ status: "unsubscribed" });
}
