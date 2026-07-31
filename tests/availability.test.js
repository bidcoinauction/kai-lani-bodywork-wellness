import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import availabilityHandler from "../api/square/availability.js";
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
  const res = await withSquareMock(
    {
      searchAvailability: async () => ({
        availabilities: [{ startAt: slotStart }],
      }),
    },
    () => run({ serviceKey: "customized_60", date: dateInDays(1) }),
  );

  assert.equal(res.statusCode, 200);
  assert.deepEqual(Object.keys(res.body).sort(), ["date", "serviceKey", "slots"]);
  assert.equal(res.body.serviceKey, "customized_60");
  assert.equal(res.body.date, dateInDays(1));
  assert.equal(res.body.slots.length, 1);
  assert.deepEqual(Object.keys(res.body.slots[0]).sort(), ["label", "startAt"]);
  assert.equal(res.body.slots[0].startAt, slotStart);
  assert.match(res.body.slots[0].label, /\d{1,2}:\d{2} (AM|PM)/);
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
  const res = await withSquareMock(
    {
      searchAvailability: async () => {
        throw new Error("raw square internal detail: LOCATION_NOT_FOUND");
      },
    },
    () => run({ serviceKey: "customized_60", date: dateInDays(1) }),
  );
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.error, "Could not load availability right now");
  assert.doesNotMatch(res.body.error, /LOCATION_NOT_FOUND|raw square/i);
});
