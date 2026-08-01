import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { sendBookingNotifications, emailTestInternals } from "../lib/email.js";

const BOOKING = {
  bookingId: "BK_EMAIL_123456",
  firstName: "Ava <script>",
  lastName: "Client & Co",
  email: "customer@example.invalid",
  phone: "+19805550100",
  serviceName: "60 Min Customized Massage",
  duration: "60",
  price: 93,
  startAt: "2026-08-05T18:00:00.000Z",
};

function clearEmailEnv() {
  for (const key of [
    "EMAIL_ENABLED",
    "EMAIL_MODE",
    "RESEND_API_KEY",
    "EMAIL_FROM",
    "EMAIL_SANDBOX_RECIPIENT",
    "CHELSEA_NOTIFICATION_EMAIL",
    "EMAIL_REPLY_TO",
    "PUBLIC_SITE_URL",
  ]) {
    delete process.env[key];
  }
}

function installEmailEnv() {
  process.env.EMAIL_ENABLED = "true";
  process.env.EMAIL_MODE = "sandbox";
  process.env.RESEND_API_KEY = "test_resend_key";
  process.env.EMAIL_FROM = "Kai Lani Sandbox <onboarding@resend.dev>";
  process.env.EMAIL_SANDBOX_RECIPIENT = "sandbox@example.invalid";
  process.env.CHELSEA_NOTIFICATION_EMAIL = "chelsea@example.invalid";
  process.env.EMAIL_REPLY_TO = "reply@example.invalid";
}

beforeEach(() => {
  clearEmailEnv();
  delete globalThis.fetch;
});

afterEach(() => {
  clearEmailEnv();
  delete globalThis.fetch;
});

test("email disabled returns disabled and sends nothing", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return { ok: true };
  };

  const result = await sendBookingNotifications(BOOKING);

  assert.deepEqual(result, { client: "disabled", provider: "disabled" });
  assert.equal(calls, 0);
});

test("missing Sandbox recipient fails closed and sends nothing", async () => {
  installEmailEnv();
  delete process.env.EMAIL_SANDBOX_RECIPIENT;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return { ok: true };
  };

  const result = await sendBookingNotifications(BOOKING);

  assert.deepEqual(result, { client: "disabled", provider: "disabled" });
  assert.equal(calls, 0);
});

test("missing or invalid mode fails closed", async () => {
  installEmailEnv();
  process.env.EMAIL_MODE = "production";
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return { ok: true };
  };

  const result = await sendBookingNotifications(BOOKING);

  assert.deepEqual(result, { client: "disabled", provider: "disabled" });
  assert.equal(calls, 0);
});

test("client and provider messages route only to Sandbox recipient", async () => {
  installEmailEnv();
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    return { ok: true };
  };

  const result = await sendBookingNotifications(BOOKING);

  assert.deepEqual(result, { client: "sent", provider: "sent" });
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.url, "https://api.resend.com/emails");
    assert.deepEqual(call.body.to, ["sandbox@example.invalid"]);
    assert.notEqual(call.body.to[0], BOOKING.email);
    assert.notEqual(call.body.to[0], process.env.CHELSEA_NOTIFICATION_EMAIL);
    assert.equal(call.body.reply_to, "reply@example.invalid");
    assert.match(call.body.subject, /^\[SANDBOX\]/);
  }
});

test("uses separate deterministic idempotency keys without PII", async () => {
  installEmailEnv();
  const keys = [];
  globalThis.fetch = async (_url, options) => {
    keys.push(options.headers["Idempotency-Key"]);
    return { ok: true };
  };

  await sendBookingNotifications(BOOKING);

  assert.deepEqual(keys, [
    "kai-lani/client-confirmation/BK_EMAIL_123456",
    "kai-lani/provider-notification/BK_EMAIL_123456",
  ]);
  assert.doesNotMatch(keys.join(" "), /customer@example|980555|Ava|Client & Co/i);
});

test("messages include escaped HTML and plain text", () => {
  const html = emailTestInternals.clientHtml({ ...BOOKING, replyTo: "reply@example.invalid" });
  const text = emailTestInternals.clientText({ ...BOOKING, replyTo: "reply@example.invalid" });

  assert.match(html, /Ava &lt;script&gt;/);
  assert.doesNotMatch(html, /Ava <script>/);
  assert.match(html, /TEST MESSAGE - NO REAL APPOINTMENT/);
  assert.match(text, /TEST MESSAGE - NO REAL APPOINTMENT/);
  assert.match(text, /Kai Lani Bodywork & Wellness/);
});

test("formats appointment time in Eastern Time", () => {
  const formatted = emailTestInternals.formatDateTime("2026-08-05T18:00:00.000Z");

  assert.match(formatted, /Wednesday, August 5, 2026/);
  assert.match(formatted, /2:00 PM EDT/);
});

test("client confirmation includes address, instructions, and phone", () => {
  const text = emailTestInternals.clientText({ ...BOOKING, replyTo: "reply@example.invalid" });

  assert.match(text, /106 S Main St, Suite F, Mount Holly, NC 28120/);
  assert.match(text, /narrow drive beside Uptown Salon/);
  assert.match(text, /black staircase/);
  assert.match(text, /\(980\) 224-2462/);
});

test("provider notification contains no raw Square data or secrets", () => {
  const html = emailTestInternals.providerHtml({
    ...BOOKING,
    rawSquareData: "SECRET_RAW_SQUARE",
    accessToken: "SECRET_TOKEN",
  });

  assert.doesNotMatch(html, /SECRET_RAW_SQUARE|SECRET_TOKEN/);
  assert.match(html, /Client email/);
  assert.match(html, /Client phone/);
});

test("Resend failure returns safe failed status only", async () => {
  installEmailEnv();
  globalThis.fetch = async () => ({ ok: false, status: 401, body: "SECRET" });

  const result = await sendBookingNotifications(BOOKING);

  assert.deepEqual(result, { client: "failed", provider: "failed" });
  assert.doesNotMatch(JSON.stringify(result), /SECRET|sandbox@example|test_resend_key/);
});
