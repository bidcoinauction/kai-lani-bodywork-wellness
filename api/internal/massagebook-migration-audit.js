import { timingSafeEqual } from "node:crypto";
import { getSquareClient } from "../../lib/square.js";
import { buildMigrationDryRunFromRows, validateAppointments } from "../../lib/massagebook-migration.js";
import { BodyReadError, readJsonBody } from "../../lib/read-json-body.js";

function safeEqualToken(actual, expected) {
  if (typeof actual !== "string" || typeof expected !== "string" || !expected) return false;
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length) {
    timingSafeEqual(expectedBuffer, expectedBuffer);
    return false;
  }
  return timingSafeEqual(actualBuffer, expectedBuffer);
}

function bearerToken(req) {
  const header = req.headers?.authorization || req.headers?.Authorization || "";
  const match = String(header).match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

function productionOnly() {
  // Keep the temporary audit surface invisible on local and preview deployments.
  // The bearer token gate is checked only after this production guard passes.
  return process.env.VERCEL_ENV === "production" && process.env.SQUARE_ENVIRONMENT === "production";
}

export default async function handler(req, res) {
  if (!productionOnly()) {
    return res.status(404).json({ error: "Not found" });
  }
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!safeEqualToken(bearerToken(req), process.env.MASSAGEBOOK_MIGRATION_AUDIT_TOKEN)) {
    return res.status(404).json({ error: "Not found" });
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    if (error instanceof BodyReadError) {
      return res.status(error.statusCode).json({ error: error.message });
    }
    throw error;
  }

  const rows = Array.isArray(body.rows) ? body.rows : null;
  if (!rows) return res.status(400).json({ error: "rows are required" });

  const validation = validateAppointments(rows);
  if (!validation.valid) {
    return res.status(400).json({ error: "invalid migration rows", validationErrors: validation.invalid });
  }

  const client = getSquareClient();
  const report = await buildMigrationDryRunFromRows({ rows, client });
  return res.status(200).json(report);
}

export const auditEndpointForTests = { safeEqualToken, productionOnly };
