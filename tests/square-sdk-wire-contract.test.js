import { test } from "node:test";
import assert from "node:assert/strict";
import square from "square";

const { SquareClient } = square;

test("Square SDK v44.2.1 emits buyer-level create query seller_level=false", async () => {
  const calls = [];
  const client = new SquareClient({
    token: "test_token_offline",
    baseUrl: "https://square-offline.example.invalid",
    maxRetries: 0,
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ booking: { id: "BK_OFFLINE", status: "PENDING", version: 0 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  const response = await client.bookings.create(
    {
      idempotencyKey: "idem-offline-wire-test",
      booking: {
        locationId: "LOC_OFFLINE",
        startAt: "2026-09-01T14:00:00Z",
        customerId: "CUST_OFFLINE",
        appointmentSegments: [
          {
            teamMemberId: "TM_OFFLINE",
            serviceVariationId: "VAR_OFFLINE",
            serviceVariationVersion: 0n,
          },
        ],
      },
    },
    { queryParams: { seller_level: false } },
  );

  assert.equal(response.booking.status, "PENDING");
  assert.equal(calls.length, 1, "intercepted fetch proves no live network request occurred");
  const url = new URL(calls[0].url);
  assert.equal(url.origin, "https://square-offline.example.invalid");
  assert.equal(url.pathname, "/v2/bookings");
  assert.equal(url.search, "?seller_level=false");
  assert.equal(url.searchParams.get("seller_level"), "false");
  assert.equal(url.searchParams.has("sellerLevel"), false);
});

test("Square SDK v44.2.1 rejects numeric serviceVariationVersion before transport", async () => {
  let called = false;
  const client = new SquareClient({
    token: "test_token_offline",
    baseUrl: "https://square-offline.example.invalid",
    maxRetries: 0,
    fetch: async () => {
      called = true;
      return new Response("{}", { status: 200 });
    },
  });

  await assert.rejects(
    client.bookings.create(
      {
        booking: {
          locationId: "LOC_OFFLINE",
          startAt: "2026-09-01T14:00:00Z",
          customerId: "CUST_OFFLINE",
          appointmentSegments: [
            {
              teamMemberId: "TM_OFFLINE",
              serviceVariationId: "VAR_OFFLINE",
              serviceVariationVersion: 0,
            },
          ],
        },
      },
      { queryParams: { seller_level: false } },
    ),
    /Expected bigint/,
  );
  assert.equal(called, false);
});

test("Square SDK v44.2.1 customer create serializes flat camelCase fields to snake_case", async () => {
  const calls = [];
  const client = new SquareClient({
    token: "test_token_offline",
    baseUrl: "https://square-offline.example.invalid",
    maxRetries: 0,
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ customer: { id: "CUST_OFFLINE" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  await client.customers.create({
    idempotencyKey: "idem-offline-customer-test",
    givenName: "Taylor",
    familyName: "Example",
    emailAddress: "taylor@example.invalid",
    phoneNumber: "+12025550147",
    referenceId: "kai-lani.customer.offline",
  });

  assert.equal(calls.length, 1, "intercepted fetch proves no live network request occurred");
  const url = new URL(calls[0].url);
  assert.equal(url.pathname, "/v2/customers");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    idempotency_key: "idem-offline-customer-test",
    given_name: "Taylor",
    family_name: "Example",
    email_address: "taylor@example.invalid",
    phone_number: "+12025550147",
    reference_id: "kai-lani.customer.offline",
  });
});
