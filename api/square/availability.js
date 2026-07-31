import { getSquareClient } from "../../lib/square.js";
import { requireBookingConfig, ConfigError } from "../../lib/config.js";
import { isServiceKey } from "../../lib/services.js";
import {
  isValidDateString,
  getNewYorkDateString,
  addDays,
  startOfDayInTimeZone,
  formatTimeLabel,
} from "../../lib/time.js";

export const MAX_DAYS_AHEAD = 13;

export default async function handler(req, res) {
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

  try {
    const client = getSquareClient();
    const dayStart = startOfDayInTimeZone(date);
    const dayEnd = addDays(dayStart, 1);

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
    console.error(
      `Availability search failed status=error`,
      { serviceKey },
    );
    return res.status(500).json({ error: "Could not load availability right now" });
  }
}
