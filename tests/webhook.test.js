import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import webhookHandler from "../api/square/webhook.js";
import { makeRequest, makeResponse } from "./helpers.js";

const NOTIFICATION_URL = "https://preview.example.vercel.app/api/square/webhook";
const SIGNATURE_KEY = "test-signature-key";

beforeEach(() => {
  process.env.SQUARE_WEBHOOK_SIGNATURE_KEY = SIGNATURE_KEY;
  process.env.SQUARE_WEBHOOK_NOTIFICATION_URL = NOTIFICATION_URL;
});

afterEach(() => {
  delete process.env.SQUARE_WEBHOOK_SIGNATURE_KEY;
  delete process.env.SQUARE_WEBHOOK_NOTIFICATION_URL;
});

function computeSignature(rawBody, url = NOTIFICATION_URL, key = SIGNATURE_KEY) {
  return crypto
    .createHmac("sha256", key)
    .update(url + rawBody)
    .digest("base64");
}

function makeEvent(rawBody, overrides = {}) {
  const event = {
    merchant_id: "sandbox-merchant",
    location_id: "sandbox-location",
    type: "booking.created",
    event_id: "evt-0001",
    created_at: "2026-07-30T12:00:00Z",
    data: {
      type: "booking",
      id: "bk-123",
      object: {
        booking: { id: "bk-123", status: "ACCEPTED", version: 0 },
      },
    },
  };
  return JSON.stringify({ ...event, ...overrides });
}

let eventCounter = 0;
function uniqueEvent(overrides = {}) {
  eventCounter += 1;
  const event = JSON.parse(makeEvent());
  event.event_id = `evt-test-${eventCounter}`;
  return JSON.stringify({ ...event, ...overrides });
}

async function run({ method = "POST", body, rawBody, headers = {} }) {
  const res = makeResponse();
  const req = makeRequest({ method, body, rawBody, headers });
  await webhookHandler(req, res);
  return res;
}

test("rejects non-POST methods with 405", async () => {
  const res = await run({ method: "GET", rawBody: makeEvent() });
  assert.equal(res.statusCode, 405);
});

test("rejects a request with no signature header", async () => {
  const res = await run({ rawBody: makeEvent() });
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.error, "Invalid signature");
});

test("rejects when webhook configuration is missing", async () => {
  delete process.env.SQUARE_WEBHOOK_SIGNATURE_KEY;
  delete process.env.SQUARE_WEBHOOK_NOTIFICATION_URL;
  const rawBody = makeEvent();
  const res = await run({
    rawBody,
    headers: { "x-square-hmacsha256-signature": computeSignature(rawBody) },
  });
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.error, "Invalid signature");
});

test("rejects an invalid signature", async () => {
  const rawBody = makeEvent();
  const res = await run({
    rawBody,
    headers: { "x-square-hmacsha256-signature": "bm90LXRoZS1yaWdodC1zaWduYXR1cmU=" },
  });
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.error, "Invalid signature");
});

test("rejects a signature computed with the wrong notification URL", async () => {
  const rawBody = makeEvent();
  const res = await run({
    rawBody,
    headers: {
      "x-square-hmacsha256-signature": computeSignature(rawBody, "https://other.example/webhook"),
    },
  });
  assert.equal(res.statusCode, 401);
});

test("accepts a valid signature and acknowledges the event", async () => {
  const rawBody = uniqueEvent();
  const res = await run({
    rawBody,
    headers: { "x-square-hmacsha256-signature": computeSignature(rawBody) },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { received: true });
});

test("rejects malformed JSON after a valid signature", async () => {
  const rawBody = "{not valid json";
  const res = await run({
    rawBody,
    headers: { "x-square-hmacsha256-signature": computeSignature(rawBody) },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, "Invalid payload");
});

test("rejects non-object JSON after a valid signature", async () => {
  const rawBody = JSON.stringify(["array", "not", "object"]);
  const res = await run({
    rawBody,
    headers: { "x-square-hmacsha256-signature": computeSignature(rawBody) },
  });
  assert.equal(res.statusCode, 400);
});

test("handles duplicate event ids idempotently", async () => {
  const rawBody = uniqueEvent();
  const signature = computeSignature(rawBody);
  const first = await run({ rawBody, headers: { "x-square-hmacsha256-signature": signature } });
  assert.equal(first.statusCode, 200);
  assert.deepEqual(first.body, { received: true });

  const second = await run({ rawBody, headers: { "x-square-hmacsha256-signature": signature } });
  assert.equal(second.statusCode, 200);
  assert.deepEqual(second.body, { received: true, duplicate: true });
});

test("fails safe when the raw body is unavailable (pre-parsed JSON)", async () => {
  const parsedEvent = JSON.parse(makeEvent());
  const res = await run({
    body: parsedEvent,
    headers: { "x-square-hmacsha256-signature": "unused" },
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /raw request body/i);
});
