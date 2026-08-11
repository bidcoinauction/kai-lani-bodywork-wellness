import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  sendBookingRequestReceivedEmail,
  sendApprovalEmail,
  sendApprovedClientEmail,
  sendApprovedProviderEmail,
  sendDeclinedClientEmail,
  sendNeedsRescheduleEmail,
  emailTestInternals,
} from "../lib/email.js";

const REQUEST = {
  requestId: "REQ_EMAIL_123456",
  requestKey: "req_email_abcdef123456",
  serviceKey: "customized_60",
  serviceName: "60 Min Customized Massage",
  durationMinutes: 60,
  startAt: "2026-08-25T14:00:00.000Z",
  firstName: "Ava <script>",
  lastName: "Client & Co",
  email: "customer@example.invalid",
  phone: "+19805550100",
  price: 93,
  bookingId: "BK_APPROVED_EMAIL_1",
  calendarUrl:
    "https://calendar.google.com/calendar/render?action=TEMPLATE&text=Kai%20Lani",
  approvalUrl: "https://preview.example.invalid/approve?token=abcdefghijklmnopqrstuvwx",
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
  process.env.PUBLIC_SITE_URL = "https://preview.example.invalid";
}

function captureCalls() {
  const calls = [];
  globalThis.fetch = async (_url, options) => {
    calls.push({ options, body: JSON.parse(options.body) });
    return { ok: true };
  };
  return calls;
}

beforeEach(() => {
  clearEmailEnv();
  delete globalThis.fetch;
});

afterEach(() => {
  clearEmailEnv();
  delete globalThis.fetch;
});

test("all request workflow emails route only to the Sandbox recipient", async () => {
  installEmailEnv();
  const calls = captureCalls();

  await sendBookingRequestReceivedEmail(REQUEST);
  await sendApprovalEmail(REQUEST);
  await sendApprovedClientEmail(REQUEST);
  await sendApprovedProviderEmail(REQUEST);
  await sendDeclinedClientEmail(REQUEST);
  await sendNeedsRescheduleEmail(REQUEST);

  assert.equal(calls.length, 6);
  for (const call of calls) {
    assert.deepEqual(call.body.to, ["sandbox@example.invalid"]);
    assert.notEqual(call.body.to[0], REQUEST.email);
    assert.notEqual(call.body.to[0], process.env.CHELSEA_NOTIFICATION_EMAIL);
    assert.match(call.body.subject, /^\[SANDBOX\]/);
  }
});

test("workflow emails use deterministic request-id idempotency keys without PII", async () => {
  installEmailEnv();
  const calls = captureCalls();

  await sendBookingRequestReceivedEmail(REQUEST);
  await sendApprovalEmail(REQUEST);
  await sendApprovedClientEmail(REQUEST);
  await sendApprovedProviderEmail(REQUEST);
  await sendDeclinedClientEmail(REQUEST);
  await sendNeedsRescheduleEmail(REQUEST);

  const keys = calls.map((call) => call.options.headers["Idempotency-Key"]);
  assert.deepEqual(keys, [
    "kai-lani/request-receipt/REQ_EMAIL_123456",
    "kai-lani/approval/REQ_EMAIL_123456",
    "kai-lani/approved-client/REQ_EMAIL_123456",
    "kai-lani/approved-provider/REQ_EMAIL_123456",
    "kai-lani/declined-client/REQ_EMAIL_123456",
    "kai-lani/needs-reschedule/REQ_EMAIL_123456",
  ]);
  assert.doesNotMatch(keys.join(" "), /customer@example|980555|Ava|Client & Co/i);
});

test("approved client email includes the Google Calendar link and ICS attachment", async () => {
  installEmailEnv();
  const calls = captureCalls();

  const status = await sendApprovedClientEmail(REQUEST);

  assert.equal(status, "sent");
  const call = calls[0];
  assert.match(call.body.html, /Add this appointment to Google Calendar/);
  assert.match(call.body.text, /Add this appointment to Google Calendar/);
  assert.equal(call.body.attachments.length, 1);
  assert.equal(call.body.attachments[0].filename, "kai-lani-appointment.ics");
  assert.ok(call.body.attachments[0].content.length > 0);
});

test("approved provider email carries the ICS attachment", async () => {
  installEmailEnv();
  const calls = captureCalls();

  const status = await sendApprovedProviderEmail(REQUEST);

  assert.equal(status, "sent");
  assert.equal(calls[0].body.attachments.length, 1);
  assert.equal(calls[0].body.attachments[0].filename, "kai-lani-appointment.ics");
});

test("decline and needs-reschedule emails carry no calendar attachment", async () => {
  installEmailEnv();
  const calls = captureCalls();

  await sendDeclinedClientEmail(REQUEST);
  await sendNeedsRescheduleEmail(REQUEST);

  for (const call of calls) {
    assert.equal(call.body.attachments, undefined);
  }
});

test("approval email missing its approval URL fails safely", async () => {
  installEmailEnv();
  const calls = captureCalls();

  const status = await sendApprovalEmail({ ...REQUEST, approvalUrl: "" });

  assert.equal(status, "failed");
  assert.equal(calls.length, 0);
});

test("disabled email mode returns disabled and sends nothing", async () => {
  const calls = captureCalls();

  const status = await sendApprovedClientEmail(REQUEST);

  assert.equal(status, "disabled");
  assert.equal(calls.length, 0);
});

test("request workflow HTML escapes client input", () => {
  const html = emailTestInternals.requestReceivedHtml({ ...REQUEST, replyTo: "reply@example.invalid" });
  const approval = emailTestInternals.approvalEmailHtml({ ...REQUEST, replyTo: "reply@example.invalid" });
  const approved = emailTestInternals.approvedClientHtml({ ...REQUEST, replyTo: "reply@example.invalid" });
  const declined = emailTestInternals.declinedClientHtml({ ...REQUEST, replyTo: "reply@example.invalid" });
  const reschedule = emailTestInternals.needsRescheduleHtml({ ...REQUEST, replyTo: "reply@example.invalid" });

  for (const fragment of [html, approval, approved, declined, reschedule]) {
    assert.match(fragment, /Ava &lt;script&gt;/);
    assert.doesNotMatch(fragment, /Ava <script>/);
  }
  // The provider-facing approval email also renders the escaped full name.
  assert.match(approval, /Client &amp; Co/);

  // Client-facing messages must never expose the client email or phone. The
  // approval email is for Chelsea, so it intentionally includes them.
  for (const fragment of [html, approved, declined, reschedule]) {
    assert.doesNotMatch(fragment, /customer@example|980555/);
  }
  assert.match(approval, /customer@example\.invalid/);
  assert.match(approval, /\+19805550100/);
});

test("approval email HTML exposes the plain approval URL with the token", () => {
  const html = emailTestInternals.approvalEmailHtml({ ...REQUEST, replyTo: "reply@example.invalid" });

  assert.match(html, /https:\/\/preview\.example\.invalid\/approve\?token=abcdefghijklmnopqrstuvwx/);
});

test("Resend failure returns safe status and logs no PII or tokens", async () => {
  installEmailEnv();
  const logs = [];
  const originalInfo = console.info;
  console.info = (message) => logs.push(String(message));
  globalThis.fetch = async () => ({
    ok: false,
    status: 422,
    json: async () => ({
      error: {
        name: "validation_error",
        code: "invalid_recipient",
        message: "SECRET with customer@example.invalid and token abcdefghijklmnopqrstuvwx",
      },
    }),
  });

  try {
    const status = await sendApprovedClientEmail(REQUEST);
    assert.equal(status, "failed");
    assert.ok(logs.length >= 1);
    for (const log of logs) {
      assert.match(log, /status=failed/);
      assert.doesNotMatch(log, /SECRET|customer@example|980555|Ava|token=abcdef|test_resend_key/);
    }
  } finally {
    console.info = originalInfo;
  }
});
