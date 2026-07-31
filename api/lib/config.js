import { getServiceConfig } from "./services.js";

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigError";
  }
}

/**
 * Validates every server-owned configuration value required to book a service.
 * Returns only internal IDs; never access tokens or signature keys.
 * Throws a ConfigError listing which environment variables are missing so the
 * operator can fix configuration without exposing any secret values.
 */
export function requireBookingConfig(serviceKey) {
  const missing = [];

  const locationId = process.env.SQUARE_LOCATION_ID;
  if (!locationId) missing.push("SQUARE_LOCATION_ID");

  const teamMemberId = process.env.SQUARE_TEAM_MEMBER_ID;
  if (!teamMemberId) missing.push("SQUARE_TEAM_MEMBER_ID");

  const service = getServiceConfig(serviceKey);
  if (!service) {
    throw new ConfigError(`Unknown service: ${serviceKey}`);
  }
  if (!service.serviceVariationId) {
    missing.push(service.variationIdEnv);
  }

  if (missing.length > 0) {
    throw new ConfigError(
      `Square booking is not fully configured. Missing: ${missing.join(", ")}`,
    );
  }

  return { locationId, teamMemberId, service };
}
