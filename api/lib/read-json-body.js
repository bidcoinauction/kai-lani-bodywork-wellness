import { readRawBody } from "./read-raw-body.js";

export const MAX_JSON_BODY_BYTES = 32 * 1024;

export class BodyReadError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.name = "BodyReadError";
    this.statusCode = statusCode;
  }
}

/**
 * Safe JSON body parser for normal API endpoints with a strict size limit.
 *
 * Accepts a body already parsed by the platform, otherwise reads the raw
 * stream and parses it. Rejects oversized or malformed bodies with a
 * BodyReadError carrying a safe client status code.
 */
export async function readJsonBody(req) {
  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) {
    const approximateBytes = Buffer.byteLength(JSON.stringify(req.body));
    if (approximateBytes > MAX_JSON_BODY_BYTES) {
      throw new BodyReadError(413, "Request body too large");
    }
    return req.body;
  }

  const raw = await readRawBody(req);
  if (!raw) {
    throw new BodyReadError(400, "Request body is required");
  }
  if (Buffer.byteLength(raw, "utf8") > MAX_JSON_BODY_BYTES) {
    throw new BodyReadError(413, "Request body too large");
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new BodyReadError(400, "Invalid JSON body");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new BodyReadError(400, "Invalid JSON body");
  }
  return parsed;
}
