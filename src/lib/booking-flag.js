/**
 * Frontend booking-requests feature flag.
 *
 * The request flow renders only when VITE_ENABLE_BOOKING_REQUESTS is exactly
 * "true". Any other value (including missing) shows the existing safe
 * fallback. The legacy VITE_ENABLE_SQUARE_SANDBOX flag is intentionally
 * ignored: it implied a Sandbox-only UI that this flow no longer has.
 * Kept as a plain module so both the UI and node tests share the same logic.
 */
export function bookingRequestsEnabled(env = {}) {
  return env.VITE_ENABLE_BOOKING_REQUESTS === "true";
}

export function legacySandboxFlagPresent(env = {}) {
  return env.VITE_ENABLE_SQUARE_SANDBOX === "true";
}