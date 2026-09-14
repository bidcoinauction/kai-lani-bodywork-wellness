#!/usr/bin/env node
import {
  buildMigrationDryRun,
  defaultInputLabel,
  loadAppointments,
  loadDotEnvFile,
  writeDryRunReport,
} from "../lib/massagebook-migration.js";

function parseArgs(argv) {
  const args = {
    execute: false,
    input: null,
    output: "migration/massagebook-migration-dry-run.json",
    envFile: ".env.local",
    auditUrl: null,
    auditTokenEnv: "MASSAGEBOOK_MIGRATION_AUDIT_TOKEN",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--execute") args.execute = true;
    else if (arg === "--input") args.input = argv[++i];
    else if (arg === "--output") args.output = argv[++i];
    else if (arg === "--env-file") args.envFile = argv[++i];
    else if (arg === "--audit-url") args.auditUrl = argv[++i];
    else if (arg === "--audit-token-env") args.auditTokenEnv = argv[++i];
    else if (arg === "--no-env-file") args.envFile = null;
    else if (!args.input) args.input = arg;
    else throw new Error(`unknown_argument:${arg}`);
  }
  return args;
}

async function runRemoteAudit(args) {
  const token = process.env[args.auditTokenEnv];
  if (!token) throw new Error(`${args.auditTokenEnv} is required for --audit-url`);
  const { rows } = loadAppointments(args.input);
  const response = await fetch(args.auditUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ rows }),
  });
  if (!response.ok) {
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    throw new Error(`audit_endpoint_failed:${response.status}${body?.error ? `:${body.error}` : ""}`);
  }
  return response.json();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.input) throw new Error("--input is required");
  if (args.envFile) loadDotEnvFile(args.envFile);

  if (args.execute) {
    throw new Error("execute_not_implemented_for_audit_task");
  }

  const report = args.auditUrl
    ? await runRemoteAudit(args)
    : await buildMigrationDryRun({ input: args.input });
  const output = writeDryRunReport(report, args.output);
  console.log(JSON.stringify({
    mode: "dry_run",
    input: defaultInputLabel(args.input),
    output,
    rows: report.summary.actualRows,
    dryRunSquareWrites: report.summary.dryRunSquareWrites,
    dryRunNeonWrites: report.summary.dryRunNeonWrites,
    serviceCounts: report.summary.serviceCounts,
    customerCounts: report.summary.customerCounts,
    bookingCounts: report.summary.bookingCounts,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
