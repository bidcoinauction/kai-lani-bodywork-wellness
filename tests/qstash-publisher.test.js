import { test } from "node:test";
import assert from "node:assert/strict";
import {
  APPROVED_QSTASH_URL,
  QStashHttpPublisher,
  QSTASH_DESTINATION_TIMEOUT,
  QSTASH_PUBLISH_TIMEOUT_MS,
  QSTASH_RETRIES,
} from "../lib/qstash-publisher.js";

const MESSAGE = {
  eventId: "evt-publish-contract",
  eventType: "booking.created",
  eventCreatedAt: "2026-07-30T12:00:00.000Z",
  bookingId: "bk-contract",
  bookingVersion: 0,
  bookingStatus: "ACCEPTED",
  bookingStartAt: "2026-11-01T15:00:00.000Z",
  locationId: "LOC_SAFE",
  appointmentSegments: [
    {
      durationMinutes: 60,
      serviceVariationId: "VAR_60",
      serviceVariationVersion: 2,
      teamMemberId: "TM_SAFE",
    },
  ],
};

test("QStash publisher uses official publish REST contract with dedupe and forwarded bypass header", async () => {
  const requests = [];
  const publisher = new QStashHttpPublisher({
    qstashUrl: APPROVED_QSTASH_URL,
    token: "qstash-token",
    workerUrl: "https://preview.example.vercel.app/api/square/webhook-worker",
    bypassSecret: "vercel-bypass-secret",
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return { ok: true, json: async () => ({ messageId: "msg_1" }) };
    },
  });

  const result = await publisher.publishSquareWebhook(MESSAGE);
  assert.deepEqual(result, { messageId: "msg_1" });
  assert.equal(requests.length, 1);
  const { url, init } = requests[0];
  assert.equal(url, `${APPROVED_QSTASH_URL}/v2/publish/https%3A%2F%2Fpreview.example.vercel.app%2Fapi%2Fsquare%2Fwebhook-worker`);
  assert.equal(init.method, "POST");
  assert.equal(init.headers.Authorization, "Bearer qstash-token");
  assert.equal(init.headers["Upstash-Deduplication-Id"], MESSAGE.eventId);
  assert.equal(init.headers["Upstash-Retries"], String(QSTASH_RETRIES));
  assert.equal(init.headers["Upstash-Timeout"], QSTASH_DESTINATION_TIMEOUT);
  assert.equal(init.headers["Upstash-Forward-x-vercel-protection-bypass"], "vercel-bypass-secret");
  assert.equal(init.headers["Upstash-Redact-Fields"], "body, header[x-vercel-protection-bypass]");
  assert.equal(Object.keys(init.headers).some((name) => name.startsWith("Upstash-Forward-Authorization")), false);
  assert.deepEqual(JSON.parse(init.body), MESSAGE);
});

test("QStash publisher treats duplicate 202 acceptance as success", async () => {
  const publisher = new QStashHttpPublisher({
    qstashUrl: APPROVED_QSTASH_URL,
    token: "qstash-token",
    workerUrl: "https://preview.example.vercel.app/api/square/webhook-worker",
    bypassSecret: "vercel-bypass-secret",
    fetchImpl: async () => ({ ok: true, status: 202, json: async () => ({ messageId: "msg_original", deduplicated: true }) }),
  });
  const result = await publisher.publishSquareWebhook(MESSAGE);
  assert.deepEqual(result, { messageId: "msg_original", deduplicated: true });
});

test("QStash publisher rejects missing config and worker URLs with query secrets", async () => {
  for (const workerUrl of [
    "https://preview.example.vercel.app/api/square/webhook-worker?x-vercel-protection-bypass=secret",
    "https://user:pass@preview.example.vercel.app/api/square/webhook-worker",
    "http://preview.example.vercel.app/api/square/webhook-worker",
    "https://preview.example.vercel.app/api/square/other-worker",
  ]) {
    let network = 0;
    await assert.rejects(
      () =>
        new QStashHttpPublisher({
          qstashUrl: APPROVED_QSTASH_URL,
          token: "qstash-token",
          workerUrl,
          bypassSecret: "secret",
          fetchImpl: async () => {
            network += 1;
            return { ok: true, json: async () => ({}) };
          },
        }).publishSquareWebhook(MESSAGE),
      /qstash_not_configured/,
    );
    assert.equal(network, 0);
  }
  await assert.rejects(
    () =>
      new QStashHttpPublisher({
        qstashUrl: APPROVED_QSTASH_URL,
        token: "",
        workerUrl: "https://preview.example.vercel.app/api/square/webhook-worker",
        bypassSecret: "secret",
        fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
      }).publishSquareWebhook(MESSAGE),
    /qstash_not_configured/,
  );
});

test("QStash publisher requires the exact US regional endpoint and never falls back to EU", async () => {
  for (const qstashUrl of [
    undefined,
    "",
    "https://qstash.upstash.io",
    "https://qstash.eu-central-1.upstash.io",
    "http://qstash-us-east-1.upstash.io",
    "https://user:pass@qstash-us-east-1.upstash.io",
    "https://qstash-us-east-1.upstash.io/v2",
    "https://qstash-us-east-1.upstash.io?region=us",
    "https://qstash-us-east-1.upstash.io#fragment",
    "not-a-url",
  ]) {
    let network = 0;
    await assert.rejects(
      () =>
        new QStashHttpPublisher({
          qstashUrl,
          token: "qstash-token",
          workerUrl: "https://preview.example.vercel.app/api/square/webhook-worker",
          bypassSecret: "vercel-bypass-secret",
          fetchImpl: async () => {
            network += 1;
            return { ok: true, json: async () => ({}) };
          },
        }).publishSquareWebhook(MESSAGE),
      /qstash_not_configured/,
    );
    assert.equal(network, 0);
  }
});

test("QStash publisher errors and logs do not expose tokens or secrets", async () => {
  const logs = [];
  const originalInfo = console.info;
  const originalError = console.error;
  console.info = (...args) => logs.push(args.join(" "));
  console.error = (...args) => logs.push(args.join(" "));
  try {
    await assert.rejects(
      () =>
        new QStashHttpPublisher({
          qstashUrl: "https://qstash.upstash.io",
          token: "qstash-secret-token",
          workerUrl: "https://preview.example.vercel.app/api/square/webhook-worker",
          bypassSecret: "vercel-bypass-secret",
          fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
        }).publishSquareWebhook(MESSAGE),
      (error) => {
        assert.equal(String(error).includes("qstash-secret-token"), false);
        assert.equal(String(error).includes("vercel-bypass-secret"), false);
        return /qstash_not_configured/.test(String(error));
      },
    );
  } finally {
    console.info = originalInfo;
    console.error = originalError;
  }
  assert.equal(logs.join("\n").includes("qstash-secret-token"), false);
  assert.equal(logs.join("\n").includes("vercel-bypass-secret"), false);
});

test("QStash publisher non-2xx is a safe failure without reading provider body", async () => {
  let bodyRead = 0;
  const publisher = new QStashHttpPublisher({
    qstashUrl: APPROVED_QSTASH_URL,
    token: "qstash-token",
    workerUrl: "https://preview.example.vercel.app/api/square/webhook-worker",
    bypassSecret: "vercel-bypass-secret",
    fetchImpl: async () => ({
      ok: false,
      status: 500,
      text: async () => {
        bodyRead += 1;
        return "secret provider body";
      },
      json: async () => {
        bodyRead += 1;
        return { error: "secret provider body" };
      },
    }),
  });
  await assert.rejects(() => publisher.publishSquareWebhook(MESSAGE), /qstash_publish_failed/);
  assert.equal(bodyRead, 0);
});

test("QStash publisher aborts bounded publish request", async () => {
  let aborted = false;
  const publisher = new QStashHttpPublisher({
    qstashUrl: APPROVED_QSTASH_URL,
    token: "qstash-token",
    workerUrl: "https://preview.example.vercel.app/api/square/webhook-worker",
    bypassSecret: "vercel-bypass-secret",
    fetchImpl: async (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          aborted = true;
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      }),
  });
  const started = Date.now();
  await assert.rejects(() => publisher.publishSquareWebhook(MESSAGE), { name: "AbortError" });
  assert.equal(aborted, true);
  assert.ok(Date.now() - started < QSTASH_PUBLISH_TIMEOUT_MS + 500);
});
