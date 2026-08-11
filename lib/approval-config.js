/**
 * Server-side gating for the booking-request approval workflow.
 *
 * Every request/lookup/approve/decline endpoint fails closed unless:
 *   - BOOKING_APPROVAL_ENABLED === "true"
 *   - BOOKING_APPROVAL_MODE === "sandbox"
 *   - SQUARE_ENVIRONMENT === "sandbox"
 *
 * Frontend gating alone is never sufficient.
 */
export function isBookingApprovalEnabled() {
  return (
    process.env.BOOKING_APPROVAL_ENABLED === "true" &&
    process.env.BOOKING_APPROVAL_MODE === "sandbox" &&
    process.env.SQUARE_ENVIRONMENT === "sandbox"
  );
}
