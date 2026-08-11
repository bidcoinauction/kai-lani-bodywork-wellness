import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "@neondatabase/serverless";

/**
 * Applies db/migrations/001_booking_requests.sql to the configured Neon
 * database. Requires DATABASE_URL in the environment.
 *
 *   npm run db:booking-requests:apply
 */
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL is required to apply migrations.");
  process.exit(1);
}

const here = fileURLToPath(new URL(".", import.meta.url));
const migrationPath = resolve(here, "..", "db", "migrations", "001_booking_requests.sql");
const migration = readFileSync(migrationPath, "utf8");

const pool = new Pool({ connectionString });
try {
  await pool.query(migration);
  console.log("Applied db/migrations/001_booking_requests.sql");
} catch (error) {
  console.error("Migration failed:", error && error.message ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await pool.end();
}
