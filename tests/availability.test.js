import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import availabilityHandler, { availabilityDiagnosticsForTests } from "../api/square/availability.js";
import { resetSquareClientForTests } from "../lib/square.js";
import {
  addDays,
  getNewYorkDateString,
  startOfDayInTimeZone,
} from "../lib/time.js";
import {
  makeRequest,
  makeResponse,
  installFullConfig,
  clearSquareEnv,
  withSquareMock,
} from "./helpers.js";

beforeEach(() => {
  resetSquareClientForTests();
});

afterEach(() => {
  clearSquareEnv();
  resetSquareClientForTests();
});

function dateInDays(days) {
  const base = startOfDayInTimeZone(getNewYorkDateString());
  return getNewYorkDateString(addDays(base, days));
}

async function run(query) {
  const res = makeResponse();
  await availabilityHandler(makeRequest({ method: "GET", query }), res);
  return res;
}

async function captureAvailabilityLogs(fn) {
  const info = console.info;
  const error = console.error;
  const logs = [];
  console.info = (...args) => logs.push({ level: "info", args });
  console.error = (...args) => logs.push({ level: "error", args });
  try {
    const result = await fn();
    return { result, logs };
  } finally {
    console.info = info;
    console.error = error;
  }
}

function diagnosticEntries(logs) {
  return logs
    .filter((entry) => entry.args[0] === "availability_diagnostic")
    .map((entry) => ({ level: entry.level, ...entry.args[1] }));
}

test("rejects non-GET methods with 405", async () => {
  const res = makeResponse();
  await availabilityHandler(makeRequest({ method: "POST", query: {} }), res);
  assert.equal(res.statusCode, 405);
});

test("requires serviceKey and date", async () => {
  const missingBoth = await run({});
  assert.equal(missingBoth.statusCode, 400);
  assert.equal(typeof missingBoth.body.error, "string");

  const missingDate = await run({ serviceKey: "customized_60" });
  assert.equal(missingDate.statusCode, 400);
});

test("rejects an unknown service key", async () => {
  const res = await run({ serviceKey: "not_a_service", date: dateInDays(1) });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, "Unknown service");
});

test("rejects malformed dates", async () => {
  for (const bad of ["2026-13-40", "2026-02-30", "07/30/2026", "2026-7-1", "today"]) {
    const res = await run({ serviceKey: "customized_60", date: bad });
    assert.equal(res.statusCode, 400, `date ${bad} should be rejected`);
  }
});

test("rejects dates in the past", async () => {
  installFullConfig();
  const res = await run({ serviceKey: "customized_60", date: dateInDays(-1) });
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /today or later/i);
});

test("enforces the 14-day booking window boundary", async () => {
  installFullConfig();
  const inside = await withSquareMock({}, () =>
    run({ serviceKey: "customized_60", date: dateInDays(13) }),
  );
  assert.equal(inside.statusCode, 200);

  const outside = await run({ serviceKey: "customized_60", date: dateInDays(14) });
  assert.equal(outside.statusCode, 400);
  assert.match(outside.body.error, /booking window/i);
});

test("returns only date, serviceKey, and slots with safe fields", async () => {
  installFullConfig();
  const slotStart = `${dateInDays(1)}T14:00:00-04:00`;
  const { result: res, logs } = await captureAvailabilityLogs(() =>
    withSquareMock(
      {
        searchAvailability: async () => ({
          availabilities: [{ startAt: slotStart }],
        }),
      },
      () => run({ serviceKey: "customized_60", date: dateInDays(1) }),
    ),
  );

  assert.equal(res.statusCode, 200);
  assert.deepEqual(Object.keys(res.body).sort(), ["date", "serviceKey", "slots"]);
  assert.equal(res.body.serviceKey, "customized_60");
  assert.equal(res.body.date, dateInDays(1));
  assert.equal(res.body.slots.length, 1);
  assert.deepEqual(Object.keys(res.body.slots[0]).sort(), ["label", "startAt"]);
  assert.equal(res.body.slots[0].startAt, slotStart);
  assert.match(res.body.slots[0].label, /\d{1,2}:\d{2} (AM|PM)/);
  const diagnostics = diagnosticEntries(logs);
  assert.deepEqual(diagnostics.map((entry) => entry.stage), [
    "config_validated",
    "square_client_started",
    "square_client_ready",
    "availability_search_started",
    "availability_search_succeeded",
  ]);
  assert.equal(diagnostics.every((entry) => entry.classification === "ok"), true);
});

test("availability success safely ignores BigInt and zero service variation versions", async () => {
  installFullConfig();
  const slotStart = `${dateInDays(1)}T15:00:00-04:00`;
  const res = await withSquareMock(
    {
      searchAvailability: async () => ({
        availabilities: [
          { startAt: slotStart, appointmentSegments: [{ serviceVariationVersion: 0n }] },
        ],
      }),
    },
    () => run({ serviceKey: "customized_60", date: dateInDays(1) }),
  );

  assert.equal(res.statusCode, 200);
  assert.doesNotThrow(() => JSON.stringify(res.body));
  assert.equal(res.body.slots.length, 1);
  assert.equal(res.body.slots[0].startAt, slotStart);
  assert.match(res.body.slots[0].label, /AM|PM/);
  assert.equal("serviceVariationVersion" in res.body.slots[0], false);
});

test("returns an empty slots array when there is no availability", async () => {
  installFullConfig();
  const res = await withSquareMock({}, () =>
    run({ serviceKey: "customized_60", date: dateInDays(1) }),
  );
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.slots, []);
});

test("returns a safe 500 when configuration is missing", async () => {
  clearSquareEnv();
  const res = await run({ serviceKey: "customized_60", date: dateInDays(1) });
  assert.equal(res.statusCode, 500);
  assert.match(res.body.error, /SQUARE_LOCATION_ID|SQUARE_TEAM_MEMBER_ID|SQUARE_SERVICE_CUSTOMIZED_60_ID/);
  assert.doesNotMatch(res.body.error, /VAR_|sandbox|token|secret/i);
});

test("normalizes Square API errors into a safe client message", async () => {
  installFullConfig();
  const { result: res, logs } = await captureAvailabilityLogs(() =>
    withSquareMock(
      {
        searchAvailability: async () => {
          throw new Error("raw square internal detail: LOCATION_NOT_FOUND token=SECRET header=AUTH body=RAW ID=VAR_SECRET");
        },
      },
      () => run({ serviceKey: "customized_60", date: dateInDays(1) }),
    ),
  );
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.error, "Could not load availability right now");
  assert.doesNotMatch(res.body.error, /LOCATION_NOT_FOUND|raw square/i);
  const renderedLogs = JSON.stringify(logs);
  assert.doesNotMatch(renderedLogs, /LOCATION_NOT_FOUND|SECRET|AUTH|RAW|VAR_SECRET|token|header|body/i);
  assert.deepEqual(diagnosticEntries(logs).at(-1), {
    level: "error",
    stage: "availability_search_failed",
    serviceKey: "customized_60",
    date: dateInDays(1),
    elapsedMs: diagnosticEntries(logs).at(-1).elapsedMs,
    classification: "unknown",
  });
});

test("client construction failure logs the client stage without raw details", async () => {
  installFullConfig();
  const { result: res, logs } = await captureAvailabilityLogs(() =>
    run({ serviceKey: "customized_60", date: dateInDays(1) }),
  );

  assert.equal(res.statusCode, 500);
  assert.equal(res.body.error, "Could not load availability right now");
  const diagnostics = diagnosticEntries(logs);
  assert.equal(diagnostics.at(-1).stage, "square_client_started");
  assert.equal(diagnostics.at(-1).classification, "square_client_config");
  assert.equal("status" in diagnostics.at(-1), false);
  assert.doesNotMatch(JSON.stringify(logs), /SQUARE_ACCESS_TOKEN|test_token|secret|Missing|configured/i);
});

test("gate mismatch is safely classified during client construction", async () => {
  installFullConfig();
  process.env.BOOKING_APPROVAL_MODE = "production";
  const { result: res, logs } = await captureAvailabilityLogs(() =>
    run({ serviceKey: "customized_60", date: dateInDays(1) }),
  );

  assert.equal(res.statusCode, 500);
  const last = diagnosticEntries(logs).at(-1);
  assert.equal(last.stage, "square_client_started");
  assert.equal(last.classification, "gate_mismatch");
});

test("search failure logs the search stage", async () => {
  installFullConfig();
  const { result: res, logs } = await captureAvailabilityLogs(() =>
    withSquareMock(
      {
        searchAvailability: async () => {
          throw { statusCode: 400, message: "unsafe mismatch detail", body: "unsafe body" };
        },
      },
      () => run({ serviceKey: "customized_60", date: dateInDays(1) }),
    ),
  );

  assert.equal(res.statusCode, 500);
  const last = diagnosticEntries(logs).at(-1);
  assert.equal(last.stage, "availability_search_failed");
  assert.equal(last.classification, "invalid_request");
  assert.equal(last.status, 400);
  assert.doesNotMatch(JSON.stringify(logs), /unsafe mismatch detail|unsafe body/i);
});

test("Square HTTP statuses are logged numerically and classified safely", () => {
  const { classifyAvailabilityError } = availabilityDiagnosticsForTests;
  assert.deepEqual(classifyAvailabilityError({ statusCode: 400 }), { classification: "invalid_request", status: 400 });
  assert.deepEqual(classifyAvailabilityError({ statusCode: 401 }), { classification: "authentication", status: 401 });
  assert.deepEqual(classifyAvailabilityError({ statusCode: 403 }), { classification: "authorization", status: 403 });
  assert.deepEqual(classifyAvailabilityError({ statusCode: 429 }), { classification: "rate_limit", status: 429 });
  assert.deepEqual(classifyAvailabilityError({ statusCode: 500 }), { classification: "square_5xx", status: 500 });
  assert.deepEqual(classifyAvailabilityError({ rawResponse: { status: 503 } }), { classification: "square_5xx", status: 503 });
});

test("invalid or missing Square statuses become unknown", () => {
  const { classifyAvailabilityError, squareErrorStatus } = availabilityDiagnosticsForTests;
  assert.equal(squareErrorStatus({ statusCode: 99 }), null);
  assert.equal(squareErrorStatus({ statusCode: 600 }), null);
  assert.equal(squareErrorStatus({ statusCode: "401" }), null);
  assert.deepEqual(classifyAvailabilityError({ statusCode: 99, message: "raw" }), { classification: "unknown", status: null });
  assert.deepEqual(classifyAvailabilityError(null), { classification: "unknown", status: null });
});
