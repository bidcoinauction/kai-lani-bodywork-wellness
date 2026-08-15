import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  applyMigrationFiles,
  discoverMigrationFiles,
  main,
} from "../scripts/db-apply-booking-requests.mjs";

function tempMigrationDir() {
  return mkdtempSync(join(tmpdir(), "kai-lani-migrations-"));
}

function makeLogger() {
  const lines = [];
  return {
    lines,
    log: (...args) => lines.push(args.join(" ")),
    error: (...args) => lines.push(args.join(" ")),
  };
}

test("migration runner discovers numbered sql files in lexical order", () => {
  const dir = tempMigrationDir();
  writeFileSync(join(dir, "002_second.sql"), "select 2;");
  writeFileSync(join(dir, "001_first.sql"), "select 1;");

  const files = discoverMigrationFiles(dir).map((file) => file.name);
  assert.deepEqual(files, ["001_first.sql", "002_second.sql"]);
});

test("migration runner ignores unrelated migration-directory files", () => {
  const dir = tempMigrationDir();
  mkdirSync(join(dir, "003_dir.sql"));
  writeFileSync(join(dir, "001_first.sql"), "select 1;");
  writeFileSync(join(dir, "README.md"), "docs");
  writeFileSync(join(dir, "abc.sql"), "select 'abc';");
  writeFileSync(join(dir, "002_second.txt"), "select 2;");

  const files = discoverMigrationFiles(dir).map((file) => file.name);
  assert.deepEqual(files, ["001_first.sql"]);
});

test("migration runner stops applying later migrations after an error", async () => {
  const dir = tempMigrationDir();
  writeFileSync(join(dir, "001_first.sql"), "select 1;");
  writeFileSync(join(dir, "002_second.sql"), "select 2;");
  writeFileSync(join(dir, "003_third.sql"), "select 3;");
  const seen = [];
  const pool = {
    query: async (sql) => {
      seen.push(sql);
      if (sql.includes("select 2")) throw new Error("safe failure");
    },
  };

  await assert.rejects(
    applyMigrationFiles(pool, discoverMigrationFiles(dir), makeLogger()),
    /safe failure/,
  );
  assert.deepEqual(seen, ["select 1;", "select 2;"]);
});

test("migration runner does not log connection strings or secrets", async () => {
  const logger = makeLogger();
  const secret = "postgres://user:super-secret@example.invalid/db";

  const exitCode = await main({ env: { DATABASE_URL: secret }, logger });

  assert.equal(exitCode, 1);
  assert.doesNotMatch(logger.lines.join("\n"), /super-secret|postgres:\/\//);
});
