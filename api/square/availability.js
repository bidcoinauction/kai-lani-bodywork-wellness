import { getSquareClient } from "../../lib/square.js";
import { requireBookingConfig, ConfigError } from "../../lib/config.js";
import { isBookingApprovalEnabled } from "../../lib/environment.js";
import { isServiceKey } from "../../lib/services.js";
import {
  isValidDateString,
  getNewYorkDateString,
  addDays,
  startOfDayInTimeZone,
  formatTimeLabel,
} from "../../lib/time.js";

export const MAX_DAYS_AHEAD = 13;

function elapsedMs(startedAt) {
  return Date.now() - startedAt;
}

function validHttpStatus(value) {
  return Number.isInteger(value) && value >= 100 && value <= 599 ? value : null;
}

function squareErrorStatus(error) {
  if (!error || typeof error !== "object") return null;
  return (
    validHttpStatus(error.statusCode) ??
    validHttpStatus(error.status) ??
    validHttpStatus(error.response?.status) ??
    validHttpStatus(error.rawResponse?.statusCode) ??
    validHttpStatus(error.rawResponse?.status)
  );
}

function classifyAvailabilityError(error, { clientStage = false } = {}) {
  const status = squareErrorStatus(error);
  if (status === 400) return { classification: "invalid_request", status };
  if (status === 401) return { classification: "authentication", status };
  if (status === 403) return { classification: "authorization", status };
  if (status === 429) return { classification: "rate_limit", status };
  if (status && status >= 500) return { classification: "square_5xx", status };

  if (clientStage) {
    if (!isBookingApprovalEnabled()) return { classification: "gate_mismatch", status: null };
    return { classification: "square_client_config", status: null };
  }

  if (error?.name === "AbortError" || error?.code === "ETIMEDOUT") {
    return { classification: "network_timeout", status: null };
  }
  if (error?.name === "TypeError" || error?.code === "ECONNRESET" || error?.code === "ENOTFOUND") {
    return { classification: "network", status: null };
  }
  return { classification: "unknown", status: null };
}

function logAvailability(stage, { serviceKey, date, startedAt, classification = "ok", status = null }) {
  const details = {
    stage,
    serviceKey,
    date,
    elapsedMs: elapsedMs(startedAt),
    classification,
  };
  if (status !== null) details.status = status;
  const message = "availability_diagnostic";
  if (classification === "ok") {
    console.info(message, details);
  } else {
    console.error(message, details);
  }
}

export default async function handler(req, res) {
  const startedAt = Date.now();
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { serviceKey, date } = req.query;

  if (!serviceKey || !date) {
    return res.status(400).json({ error: "serviceKey and date are required" });
  }

  if (!isServiceKey(serviceKey)) {
    return res.status(400).json({ error: "Unknown service" });
  }

  if (!isValidDateString(date)) {
    return res.status(400).json({ error: "Invalid date. Expected YYYY-MM-DD." });
  }

  const today = getNewYorkDateString();
  if (date < today) {
    return res.status(400).json({ error: "Date must be today or later" });
  }
  const latestDate = getNewYorkDateString(addDays(startOfDayInTimeZone(today), MAX_DAYS_AHEAD));
  if (date > latestDate) {
    return res.status(400).json({ error: "Date is outside the 14-day booking window" });
  }

  let config;
  try {
    config = requireBookingConfig(serviceKey);
  } catch (error) {
    if (error instanceof ConfigError) {
      return res.status(500).json({ error: error.message });
    }
    throw error;
  }

  logAvailability("config_validated", { serviceKey, date, startedAt });

  let client;
  try {
    logAvailability("square_client_started", { serviceKey, date, startedAt });
    client = getSquareClient();
    logAvailability("square_client_ready", { serviceKey, date, startedAt });
  } catch (error) {
    const { classification, status } = classifyAvailabilityError(error, { clientStage: true });
    logAvailability("square_client_started", { serviceKey, date, startedAt, classification, status });
    return res.status(500).json({ error: "Could not load availability right now" });
  }

  try {
    const dayStart = startOfDayInTimeZone(date);
    const dayEnd = addDays(dayStart, 1);

    logAvailability("availability_search_started", { serviceKey, date, startedAt });
    const response = await client.bookings.searchAvailability({
      query: {
        filter: {
          startAtRange: {
            startAt: dayStart.toISOString(),
            endAt: dayEnd.toISOString(),
          },
          locationId: config.locationId,
          segmentFilters: [
            {
              serviceVariationId: config.service.serviceVariationId,
              teamMemberIdFilter: { any: [config.teamMemberId] },
            },
          ],
        },
      },
    });
    logAvailability("availability_search_succeeded", { serviceKey, date, startedAt });

    const slots = (response.availabilities || [])
      .map((availability) => availability.startAt)
      .filter((startAt) => typeof startAt === "string")
      .sort()
      .map((startAt) => ({
        startAt,
        label: formatTimeLabel(startAt),
      }));

    return res.status(200).json({
      date,
      serviceKey,
      slots,
    });
  } catch (error) {
    const { classification, status } = classifyAvailabilityError(error);
    logAvailability("availability_search_failed", { serviceKey, date, startedAt, classification, status });
    return res.status(500).json({ error: "Could not load availability right now" });
  }
}

export const availabilityDiagnosticsForTests = {
  classifyAvailabilityError,
  squareErrorStatus,
};
