import { createHash, randomBytes } from "node:crypto";

/**
 * Server-only secret token helpers.
 *
 * Approval tokens and unsubscribe tokens are high-entropy random values that
 * are sent ONLY through private channels (the emailed approval URL, or a
 * future marketing email's List-Unsubscribe header). They are never stored,
 * logged, or returned by any API: only their SHA-256 hash is persisted, so a
 * database leak cannot be replayed as an approval or unsubscribe action and
 * logs never contain the value.
 */

/**
 * Default approval-token lifetime. A pending request whose approval token
 * expires is swept to `expired` and releases its website hold.
 */
export const APPROVAL_TOKEN_TTL_MINUTES = 1440;

/**
 * Resolves the configured approval-token lifetime in minutes, defaulting to
 * 1440 when BOOKING_APPROVAL_TOKEN_TTL_MINUTES is absent or invalid.
 */
export function approvalTokenTtlMinutes() {
  const value = Number(process.env.BOOKING_APPROVAL_TOKEN_TTL_MINUTES);
  return Number.isInteger(value) && value > 0 ? value : APPROVAL_TOKEN_TTL_MINUTES;
}

/**
 * Generates a fresh secret token from 32 random bytes, URL-safe base64.
 * Validated to a fixed 24-32 byte range so it is both unguessable and
 * URL-safe across every email client.
 */
export function generateApprovalToken(byteLength = 32) {
  const length = Number(byteLength);
  if (!Number.isInteger(length) || length < 24 || length > 32) {
    throw new RangeError("secret token length must be between 24 and 32 bytes");
  }
  return randomBytes(length).toString("base64url");
}

/**
 * SHA-256 hex digest of a raw secret token. This is the only form ever
 * written to the database.
 */
export function hashToken(token) {
  if (typeof token !== "string" || token.length === 0) {
    throw new TypeError("token is required");
  }
  return createHash("sha256").update(token, "utf8").digest("hex");
}
