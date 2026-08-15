/**
 * Server-side gating for the booking-request approval workflow.
 *
 * Every request/lookup/approve/decline/unsubscribe endpoint fails closed unless
 * the central environment gate passes:
 *   - BOOKING_APPROVAL_ENABLED === "true"
 *   - BOOKING_APPROVAL_MODE is exactly "sandbox" or "production"
 *   - SQUARE_ENVIRONMENT is exactly "sandbox" or "production"
 *   - BOOKING_APPROVAL_MODE matches SQUARE_ENVIRONMENT
 *
 * The implementation lives in ./environment.js so the Square client and email
 * delivery share the same explicit two-mode resolution instead of duplicating
 * environment checks. Production is never assumed; a missing or mismatched
 * mode always fails closed.
 *
 * Frontend gating alone is never sufficient.
 */
export { isBookingApprovalEnabled } from "./environment.js";
