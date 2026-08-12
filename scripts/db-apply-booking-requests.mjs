import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "@neondatabase/serverless";

/**
 * Applies numbered db/migrations/*.sql files to the configured Neon database
 * in deterministic lexical order. Requires DATABASE_URL in the environment.
 *
 *   npm run db:booking-requests:apply
 */

const here = fileURLToPath(new URL(".", import.meta.url));
const defaultMigrationsDir = resolve(here, "..", "db", "migrations");

export function discoverMigrationFiles(migrationsDir = defaultMigrationsDir) {
  return readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^\d+_.+\.sql$/u.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .map((name) => ({ name, path: join(migrationsDir, name) }));
}

export async function applyMigrationFiles(pool, migrationFiles, logger = console) {
  for (const migrationFile of migrationFiles) {
    const migration = readFileSync(migrationFile.path, "utf8");
    await pool.query(migration);
    logger.log(`Applied db/migrations/${migrationFile.name}`);
  }
}

export async function main({ env = process.env, logger = console } = {}) {
  const connectionString = env.DATABASE_URL;
  if (!connectionString) {
    logger.error("DATABASE_URL is required to apply migrations.");
    return 1;
  }

  const migrationFiles = discoverMigrationFiles();
  const pool = new Pool({ connectionString });
  try {
    await applyMigrationFiles(pool, migrationFiles, logger);
    return 0;
  } catch (error) {
    logger.error("Migration failed:", error && error.message ? error.message : String(error));
    return 1;
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = await main();
}
