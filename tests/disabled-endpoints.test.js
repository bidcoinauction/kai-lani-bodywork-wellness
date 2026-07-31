import { test } from "node:test";
import assert from "node:assert/strict";
import customersHandler from "../api/square/customers.js";
import cancelBookingHandler from "../api/square/cancel-booking.js";
import dashboardAppointmentsHandler from "../api/square/dashboard/appointments.js";
import dashboardAuthHandler from "../api/square/dashboard/auth.js";
import { makeRequest, makeResponse } from "./helpers.js";

async function call(handler, method, body) {
  const res = makeResponse();
  await handler(makeRequest({ method, body }), res);
  return res;
}

test("customers endpoint is disabled with 501", async () => {
  const res = await call(customersHandler, "POST", { email: "test-client@example.invalid" });
  assert.equal(res.statusCode, 501);
  assert.equal(res.body.error, "Not implemented");
});

test("customers endpoint does not proxy customer operations", async () => {
  const res = await call(customersHandler, "POST", { email: "test-client@example.invalid" });
  assert.equal(res.statusCode, 501);
  assert.equal(res.body.customer, undefined);
  assert.equal(res.body.customers, undefined);
  assert.doesNotMatch(JSON.stringify(res.body), /test-client@example\.invalid/i);
});

test("cancellation endpoint is disabled with 501", async () => {
  const res = await call(cancelBookingHandler, "POST", { bookingId: "BK_1" });
  assert.equal(res.statusCode, 501);
  assert.equal(res.body.error, "Not implemented");
});

test("dashboard endpoints are disabled with 501", async () => {
  const appointments = await call(dashboardAppointmentsHandler, "GET");
  assert.equal(appointments.statusCode, 501);

  const auth = await call(dashboardAuthHandler, "POST", {});
  assert.equal(auth.statusCode, 501);
});
