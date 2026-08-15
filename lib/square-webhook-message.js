export const SUPPORTED_SQUARE_BOOKING_EVENTS = new Set(["booking.created", "booking.updated"]);

export const MAX_QSTASH_MESSAGE_BYTES = 16 * 1024;
export const MAX_APPOINTMENT_SEGMENTS = 4;
export const MIN_SEGMENT_DURATION_MINUTES = 1;
export const MAX_SEGMENT_DURATION_MINUTES = 1440;

const MESSAGE_KEYS = [
  "eventId",
  "eventType",
  "eventCreatedAt",
  "bookingId",
  "bookingVersion",
  "bookingStatus",
  "bookingStartAt",
  "locationId",
  "appointmentSegments",
];
const SEGMENT_KEYS = ["durationMinutes", "serviceVariationId", "serviceVariationVersion", "teamMemberId"];
const RAW_SEGMENT_KEYS = [
  "durationMinutes",
  "duration_minutes",
  "serviceVariationId",
  "service_variation_id",
  "serviceVariationVersion",
  "service_variation_version",
  "teamMemberId",
  "team_member_id",
];

export class SquareWebhookMessageError extends Error {
  constructor(code) {
    super(code);
    this.name = "SquareWebhookMessageError";
    this.code = code;
  }
}

export function safeString(value, max = 120) {
  if (typeof value !== "string") return "";
  const cleaned = value.trim();
  if (!/^[A-Za-z0-9_.:-]{1,120}$/.test(cleaned)) return "redacted";
  return cleaned.slice(0, max);
}

export function bookingVersion(value) {
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return null;
}

export function canonicalBookingId(value) {
  if (typeof value !== "string") return "";
  const bookingId = value.trim();
  if (!/^[A-Za-z0-9_.-]{1,120}$/.test(bookingId)) return "";
  return bookingId;
}

function safeOptionalId(value, field) {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || !/^[A-Za-z0-9_.:-]{1,120}$/.test(value.trim())) {
    throw new SquareWebhookMessageError(`${field}_invalid`);
  }
  return value.trim();
}

function requiredDateString(value, field) {
  if (typeof value !== "string" || Number.isNaN(new Date(value).getTime())) {
    throw new SquareWebhookMessageError(`${field}_invalid`);
  }
  return new Date(value).toISOString();
}

function pickValue(object, keys) {
  for (const key of keys) {
    const value = object[key];
    if (value !== undefined) return value;
  }
  return undefined;
}

export function segmentDurationMinutes(value) {
  let num;
  if (typeof value === "number") {
    num = value;
  } else if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    num = Number(value);
  } else {
    return null;
  }
  if (!Number.isInteger(num)) return null;
  if (num < MIN_SEGMENT_DURATION_MINUTES || num > MAX_SEGMENT_DURATION_MINUTES) return null;
  return num;
}

function normalizeSegment(segment, index) {
  if (!segment || typeof segment !== "object" || Array.isArray(segment)) {
    throw new SquareWebhookMessageError(`appointment_segment_${index}_invalid`);
  }
  rejectExtraKeys(segment, SEGMENT_KEYS, "appointment_segment_keys_invalid");
  const durationMinutes = segmentDurationMinutes(segment.durationMinutes);
  if (durationMinutes == null) {
    throw new SquareWebhookMessageError("appointment_segment_duration_invalid");
  }
  const serviceVariationVersion = bookingVersion(segment.serviceVariationVersion);
  return {
    durationMinutes,
    serviceVariationId: safeOptionalId(segment.serviceVariationId, "service_variation_id"),
    serviceVariationVersion,
    teamMemberId: safeOptionalId(segment.teamMemberId, "team_member_id"),
  };
}

function parseRawSegment(segment, index) {
  if (!segment || typeof segment !== "object" || Array.isArray(segment)) {
    throw new SquareWebhookMessageError(`appointment_segment_${index}_invalid`);
  }
  rejectExtraKeys(segment, RAW_SEGMENT_KEYS, "appointment_segment_keys_invalid");
  return normalizeSegment(
    {
      durationMinutes: segmentDurationMinutes(pickValue(segment, ["duration_minutes", "durationMinutes"])),
      serviceVariationId: pickValue(segment, ["service_variation_id", "serviceVariationId"]),
      serviceVariationVersion: pickValue(segment, ["service_variation_version", "serviceVariationVersion"]),
      teamMemberId: pickValue(segment, ["team_member_id", "teamMemberId"]),
    },
    index,
  );
}

function rejectExtraKeys(value, allowed, code) {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) throw new SquareWebhookMessageError(code);
  }
}

export function buildSquareWebhookQueueMessage(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    throw new SquareWebhookMessageError("event_invalid");
  }
  const eventType = typeof event.type === "string" ? event.type : "";
  if (!SUPPORTED_SQUARE_BOOKING_EVENTS.has(eventType)) {
    throw new SquareWebhookMessageError("event_type_unsupported");
  }
  const eventId = safeOptionalId(event.event_id, "event_id");
  if (!eventId) throw new SquareWebhookMessageError("event_id_missing");
  const booking = event.data?.object?.booking;
  if (!booking || typeof booking !== "object" || Array.isArray(booking)) {
    throw new SquareWebhookMessageError("booking_missing");
  }
  const bookingId = canonicalBookingId(booking.id);
  if (!bookingId) throw new SquareWebhookMessageError("booking_id_invalid");
  const version = bookingVersion(booking.version);
  if (version == null) throw new SquareWebhookMessageError("booking_version_invalid");
  if (typeof booking.status !== "string" || !/^[A-Z_]{1,80}$/.test(booking.status)) {
    throw new SquareWebhookMessageError("booking_status_invalid");
  }
  const startAt = requiredDateString(pickValue(booking, ["start_at", "startAt"]), "booking_start_at");
  const locationId = safeOptionalId(
    pickValue(booking, ["location_id", "locationId"]) || event.location_id,
    "location_id",
  );
  if (!locationId) throw new SquareWebhookMessageError("location_id_missing");
  const appointmentSegments = pickValue(booking, ["appointment_segments", "appointmentSegments"]);
  if (!Array.isArray(appointmentSegments) || appointmentSegments.length === 0) {
    throw new SquareWebhookMessageError("appointment_segments_missing");
  }
  if (appointmentSegments.length > MAX_APPOINTMENT_SEGMENTS) {
    throw new SquareWebhookMessageError("appointment_segments_too_many");
  }

  const message = {
    eventId,
    eventType,
    eventCreatedAt: requiredDateString(event.created_at, "event_created_at"),
    bookingId,
    bookingVersion: version,
    bookingStatus: booking.status,
    bookingStartAt: startAt,
    locationId,
    appointmentSegments: appointmentSegments.map(parseRawSegment),
  };
  validateSquareWebhookQueueMessage(message);
  return message;
}

export function validateSquareWebhookQueueMessage(message) {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    throw new SquareWebhookMessageError("message_invalid");
  }
  rejectExtraKeys(message, MESSAGE_KEYS, "message_keys_invalid");
  const eventId = safeOptionalId(message.eventId, "event_id");
  if (!eventId) throw new SquareWebhookMessageError("event_id_missing");
  if (!SUPPORTED_SQUARE_BOOKING_EVENTS.has(message.eventType)) {
    throw new SquareWebhookMessageError("event_type_invalid");
  }
  requiredDateString(message.eventCreatedAt, "event_created_at");
  if (!canonicalBookingId(message.bookingId)) throw new SquareWebhookMessageError("booking_id_invalid");
  if (bookingVersion(message.bookingVersion) == null) {
    throw new SquareWebhookMessageError("booking_version_invalid");
  }
  if (typeof message.bookingStatus !== "string" || !/^[A-Z_]{1,80}$/.test(message.bookingStatus)) {
    throw new SquareWebhookMessageError("booking_status_invalid");
  }
  requiredDateString(message.bookingStartAt, "booking_start_at");
  if (!safeOptionalId(message.locationId, "location_id")) {
    throw new SquareWebhookMessageError("location_id_missing");
  }
  if (!Array.isArray(message.appointmentSegments) || message.appointmentSegments.length === 0) {
    throw new SquareWebhookMessageError("appointment_segments_missing");
  }
  if (message.appointmentSegments.length > MAX_APPOINTMENT_SEGMENTS) {
    throw new SquareWebhookMessageError("appointment_segments_too_many");
  }
  message.appointmentSegments.forEach(normalizeSegment);
  const bytes = Buffer.byteLength(JSON.stringify(message), "utf8");
  if (bytes > MAX_QSTASH_MESSAGE_BYTES) throw new SquareWebhookMessageError("message_too_large");
  return message;
}
