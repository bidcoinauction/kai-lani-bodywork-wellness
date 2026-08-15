/**
 * Central, explicit environment-mode resolution for the Kai Lani booking
 * workflow, Square, and email delivery.
 *
 * Only two modes exist: "sandbox" and "production". Missing, malformed,
 * mixed-case, or unknown values fail closed (resolve to null). Production is
 * never assumed: every gate below requires every relevant environment variable
 * to be set exactly.
 */

const ALLOWED_MODES = new Set(["sandbox", "production"]);

/**
 * Exact-match normalize: returns "sandbox" | "production" when the value is
 * exactly one of those, otherwise null. Mixed case and unknown values fail
 * closed.
 */
export function normalizeMode(value) {
  return ALLOWED_MODES.has(value) ? value : null;
}

/**
 * SQUARE_ENVIRONMENT: "sandbox" | "production" | null.
 */
export function squareEnvironment() {
  return normalizeMode(process.env.SQUARE_ENVIRONMENT);
}

/**
 * BOOKING_APPROVAL_MODE: "sandbox" | "production" | null.
 */
export function bookingApprovalMode() {
  return normalizeMode(process.env.BOOKING_APPROVAL_MODE);
}

/**
 * EMAIL_MODE: "sandbox" | "production" | null.
 */
export function emailMode() {
  return normalizeMode(process.env.EMAIL_MODE);
}

/**
 * The booking-request workflow is enabled only when BOOKING_APPROVAL_ENABLED
 * is exactly "true" and BOOKING_APPROVAL_MODE is exactly sandbox or
 * production and matches SQUARE_ENVIRONMENT exactly.
 *
 * This is the single source of truth used by every API handler, the Square
 * client constructor, and email delivery. A missing or mismatched mode always
 * fails closed; production is never assumed.
 */
export function isBookingApprovalEnabled() {
  if (process.env.BOOKING_APPROVAL_ENABLED !== "true") return false;
  const square = squareEnvironment();
  const approval = bookingApprovalMode();
  if (!square || !approval) return false;
  return square === approval;
}

/**
 * The active approval mode ("sandbox" | "production") when the booking
 * workflow is fully enabled, otherwise null.
 */
export function activeApprovalMode() {
  return isBookingApprovalEnabled() ? bookingApprovalMode() : null;
}

/**
 * Email delivery requires EMAIL_ENABLED=true, a valid EMAIL_MODE, the full
 * booking-approval gate, and an EMAIL_MODE matching the same explicit
 * environment. Returns "sandbox" | "production" | null. Production is never
 * assumed and neutral-from-neutral routing only happens when both the booking
 * and email modes agree with SQUARE_ENVIRONMENT.
 */
export function emailDeliveryMode() {
  if (process.env.EMAIL_ENABLED !== "true") return null;
  if (!isBookingApprovalEnabled()) return null;
  const mode = emailMode();
  if (!mode) return null;
  return mode === squareEnvironment() ? mode : null;
}