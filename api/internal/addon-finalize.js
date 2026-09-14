import { timingSafeEqual } from "node:crypto";
import { Pool } from "@neondatabase/serverless";
import { getSquareClient } from "../../lib/square.js";
import { isExactFacialMassageAddOnVariation } from "../../lib/add-ons.js";

const TOKEN_ENV = "ADDON_FINALIZE_TOKEN";
const ADDON_SQL = `
ALTER TABLE booking_requests
  ADD COLUMN IF NOT EXISTS add_on_keys jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE booking_requests
  DROP CONSTRAINT IF EXISTS booking_requests_add_on_keys_array_check;

ALTER TABLE booking_requests
  ADD CONSTRAINT booking_requests_add_on_keys_array_check
  CHECK (jsonb_typeof(add_on_keys) = 'array');
`;

function suffix(id) {
  return id ? `...${String(id).slice(-6)}` : null;
}

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function authorized(req) {
  const configured = process.env[TOKEN_ENV];
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  return Boolean(configured) && safeEqual(token, configured);
}

function assertProduction() {
  return process.env.SQUARE_ENVIRONMENT === "production" && process.env.BOOKING_APPROVAL_MODE === "production";
}

async function applyMigration() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) return { applied: false, error: "database_url_missing" };
  const pool = new Pool({ connectionString });
  try {
    await pool.query(ADDON_SQL);
    return { applied: true };
  } catch (error) {
    const code = error && typeof error === "object" ? error.code : null;
    return { applied: false, error: code ? `database_error_${code}` : "database_error" };
  } finally {
    await pool.end();
  }
}

async function auditCatalog() {
  const client = getSquareClient();
  const response = await client.catalog.searchItems({ productTypes: ["APPOINTMENTS_SERVICE"] });
  const items = response?.items || [];
  for (const item of items) {
    for (const variation of item.itemData?.variations || []) {
      if (isExactFacialMassageAddOnVariation({ itemName: item.itemData?.name, variation })) {
        return {
          found: true,
          itemName: item.itemData?.name,
          variationName: variation.itemVariationData?.name,
          itemSuffix: suffix(item.id),
          variationSuffix: suffix(variation.id),
          variationId: variation.id,
          durationMinutes: Math.round(Number(variation.itemVariationData?.serviceDuration) / 60000),
          priceCents: Number(variation.itemVariationData?.priceMoney?.amount),
          currency: variation.itemVariationData?.priceMoney?.currency,
        };
      }
    }
  }
  return { found: false };
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });
  if (!assertProduction()) return res.status(409).json({ error: "production_only" });
  if (!authorized(req)) return res.status(401).json({ error: "unauthorized" });
  const mode = req.body?.mode;
  if (!["apply_migration", "audit_catalog"].includes(mode)) return res.status(400).json({ error: "invalid_mode" });
  try {
    if (mode === "apply_migration") return res.status(200).json({ mode, ...(await applyMigration()) });
    return res.status(200).json({ mode, ...(await auditCatalog()) });
  } catch {
    return res.status(500).json({ error: "addon_finalize_failed" });
  }
}