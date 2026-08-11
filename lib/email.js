import { buildIcsAttachment } from "./calendar.js";

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const EMAIL_TIMEOUT_MS = 8000;
const BOOKING_TIMEZONE = "America/New_York";
const ARRIVAL_INSTRUCTIONS =
  "From South Main Street, enter the narrow drive beside Uptown Salon and follow it behind the building. Look for the black staircase. The Suite F entrance is through the door just beyond the staircase on the main level. You do not need to go up the stairs.";

const LOCATION = "106 S Main St, Suite F, Mount Holly, NC 28120";
const BUSINESS_PHONE = "(980) 224-2462";
const TEST_BANNER = "TEST MESSAGE - NO REAL APPOINTMENT";

function isEnabled() {
  return process.env.EMAIL_ENABLED === "true";
}

function isSandboxMode() {
  return process.env.EMAIL_MODE === "sandbox";
}

function hasEmailShape(value) {
  return typeof value === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function bookingSuffix(bookingId) {
  return String(bookingId || "").slice(-6) || "unknown";
}

function formatDateTime(startAt) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: BOOKING_TIMEZONE,
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(startAt));
}

function dollars(value) {
  return typeof value === "number" ? `$${value}` : "";
}

function clientHtml(data) {
  const dateTime = escapeHtml(formatDateTime(data.startAt));
  return `<!doctype html>
<html>
  <body style="font-family: Arial, sans-serif; color: #1f2d2f; line-height: 1.5;">
    <div style="border: 2px solid #b85c38; padding: 12px; margin-bottom: 18px; font-weight: 700;">${TEST_BANNER}</div>
    <h1>Kai Lani Bodywork &amp; Wellness</h1>
    <p>This is a Square Sandbox test confirmation. No real appointment was created.</p>
    <p>Hi ${escapeHtml(data.firstName)},</p>
    <p>Your test booking details are below.</p>
    <dl>
      <dt>Service</dt><dd>${escapeHtml(data.serviceName)} (${escapeHtml(data.duration)} min)</dd>
      <dt>Date and time</dt><dd>${dateTime}</dd>
      <dt>Price</dt><dd>${escapeHtml(dollars(data.price))}</dd>
      <dt>Booking reference</dt><dd>${escapeHtml(data.bookingId)}</dd>
      <dt>Location</dt><dd>${escapeHtml(LOCATION)}</dd>
      <dt>Phone</dt><dd>${escapeHtml(BUSINESS_PHONE)}</dd>
      <dt>Reply-to</dt><dd>${escapeHtml(data.replyTo)}</dd>
    </dl>
    <h2>Arrival instructions</h2>
    <p>${escapeHtml(ARRIVAL_INSTRUCTIONS)}</p>
  </body>
</html>`;
}

function clientText(data) {
  return [
    TEST_BANNER,
    "Kai Lani Bodywork & Wellness",
    "This is a Square Sandbox test confirmation. No real appointment was created.",
    `Hi ${data.firstName},`,
    `Service: ${data.serviceName} (${data.duration} min)`,
    `Date and time: ${formatDateTime(data.startAt)}`,
    `Price: ${dollars(data.price)}`,
    `Booking reference: ${data.bookingId}`,
    `Location: ${LOCATION}`,
    `Arrival instructions: ${ARRIVAL_INSTRUCTIONS}`,
    `Phone: ${BUSINESS_PHONE}`,
    `Reply-to: ${data.replyTo}`,
  ].join("\n");
}

function providerHtml(data) {
  const dateTime = escapeHtml(formatDateTime(data.startAt));
  return `<!doctype html>
<html>
  <body style="font-family: Arial, sans-serif; color: #1f2d2f; line-height: 1.5;">
    <div style="border: 2px solid #b85c38; padding: 12px; margin-bottom: 18px; font-weight: 700;">${TEST_BANNER}</div>
    <h1>New Kai Lani test appointment</h1>
    <dl>
      <dt>Client</dt><dd>${escapeHtml(data.firstName)} ${escapeHtml(data.lastName)}</dd>
      <dt>Service</dt><dd>${escapeHtml(data.serviceName)} (${escapeHtml(data.duration)} min)</dd>
      <dt>Date and time</dt><dd>${dateTime}</dd>
      <dt>Client email</dt><dd>${escapeHtml(data.email)}</dd>
      <dt>Client phone</dt><dd>${escapeHtml(data.phone)}</dd>
      <dt>Booking reference</dt><dd>${escapeHtml(data.bookingId)}</dd>
    </dl>
  </body>
</html>`;
}

function providerText(data) {
  return [
    TEST_BANNER,
    "New Kai Lani test appointment",
    `Client: ${data.firstName} ${data.lastName}`,
    `Service: ${data.serviceName} (${data.duration} min)`,
    `Date and time: ${formatDateTime(data.startAt)}`,
    `Client email: ${data.email}`,
    `Client phone: ${data.phone}`,
    `Booking reference: ${data.bookingId}`,
  ].join("\n");
}

function canSend() {
  if (!isEnabled()) return false;
  if (!isSandboxMode()) return false;
  if (!process.env.RESEND_API_KEY) return false;
  if (!hasEmailShape(process.env.EMAIL_SANDBOX_RECIPIENT)) return false;
  if (!process.env.EMAIL_FROM) return false;
  return true;
}

function safeResendErrorField(value) {
  if (typeof value !== "string") return "none";
  const cleaned = value.trim();
  if (!/^[A-Za-z0-9_.:-]{1,80}$/.test(cleaned)) return "redacted";
  return cleaned;
}

async function readSafeResendError(response) {
  const fallback = { name: "none", code: "none" };
  try {
    const body = await response.json();
    const error = body?.error && typeof body.error === "object" ? body.error : body;
    return {
      name: safeResendErrorField(error?.name),
      code: safeResendErrorField(error?.code),
    };
  } catch {
    return fallback;
  }
}

function logEmailStatus(metadata, status, details = {}) {
  const httpStatus = Number.isInteger(details.httpStatus) ? String(details.httpStatus) : "none";
  const errorName = safeResendErrorField(details.errorName);
  const errorCode = safeResendErrorField(details.errorCode);
  console.info(
    `Email notification type=${metadata.type} bookingSuffix=${metadata.bookingSuffix} status=${status} httpStatus=${httpStatus} errorName=${errorName} errorCode=${errorCode}`,
  );
}

async function postResend(payload, idempotencyKey, metadata) {
  if (!canSend()) {
    logEmailStatus(metadata, "disabled");
    return "disabled";
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), EMAIL_TIMEOUT_MS);
  try {
    const response = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (response.ok) {
      logEmailStatus(metadata, "sent", { httpStatus: response.status });
      return "sent";
    }
    const error = await readSafeResendError(response);
    logEmailStatus(metadata, "failed", {
      httpStatus: response.status,
      errorName: error.name,
      errorCode: error.code,
    });
    return "failed";
  } catch {
    logEmailStatus(metadata, "failed", { errorName: "network_or_timeout" });
    return "failed";
  } finally {
    clearTimeout(timeout);
  }
}

function basePayload(subject, html, text, attachments) {
  const payload = {
    from: process.env.EMAIL_FROM,
    to: [process.env.EMAIL_SANDBOX_RECIPIENT],
    reply_to: process.env.EMAIL_REPLY_TO || undefined,
    subject,
    html,
    text,
  };
  if (Array.isArray(attachments) && attachments.length > 0) {
    payload.attachments = attachments;
  }
  return payload;
}

export async function sendBookingNotifications(booking) {
  const bookingId = String(booking.bookingId || "");
  const suffix = bookingSuffix(bookingId);
  const data = {
    ...booking,
    replyTo: process.env.EMAIL_REPLY_TO || "",
  };

  const client = await postResend(
    basePayload(
      "[SANDBOX] Kai Lani test booking confirmation",
      clientHtml(data),
      clientText(data),
    ),
    `kai-lani/client-confirmation/${bookingId}`,
    { type: "client-confirmation", bookingSuffix: suffix },
  );

  const provider = await postResend(
    basePayload(
      "[SANDBOX] New Kai Lani test appointment",
      providerHtml(data),
      providerText(data),
    ),
    `kai-lani/provider-notification/${bookingId}`,
    { type: "provider-notification", bookingSuffix: suffix },
  );

  return { client, provider };
}

// ---------------------------------------------------------------------------
// Booking-request approval workflow emails.
//
// Every message is sandbox-only and forced to EMAIL_SANDBOX_RECIPIENT. The
// per-email status is returned to the caller ('sent' | 'failed' | 'disabled')
// and persisted per request so delivery can be audited without storing raw
// provider responses.
// ---------------------------------------------------------------------------

function requestSuffix(requestId) {
  return String(requestId || "").slice(-6) || "unknown";
}

function requestData(request) {
  return {
    ...request,
    replyTo: process.env.EMAIL_REPLY_TO || "",
  };
}

function requestDetailsHtml(data) {
  return [
    `<dt>Service</dt><dd>${escapeHtml(data.serviceName)} (${escapeHtml(data.durationMinutes)} min)</dd>`,
    `<dt>Date and time</dt><dd>${escapeHtml(formatDateTime(data.startAt))}</dd>`,
    data.price != null
      ? `<dt>Price</dt><dd>${escapeHtml(dollars(Number(data.price)))}</dd>`
      : "",
    `<dt>Request reference</dt><dd>${escapeHtml(data.requestId)}</dd>`,
  ]
    .filter(Boolean)
    .join("");
}

function requestReceivedHtml(data) {
  return `<!doctype html>
<html>
  <body style="font-family: Arial, sans-serif; color: #1f2d2f; line-height: 1.5;">
    <div style="border: 2px solid #b85c38; padding: 12px; margin-bottom: 18px; font-weight: 700;">${TEST_BANNER}</div>
    <h1>Kai Lani Bodywork &amp; Wellness</h1>
    <p>Hi ${escapeHtml(data.firstName)},</p>
    <p>Your appointment request was sent. Chelsea will review your requested time. Your appointment is not confirmed until you receive an approval email.</p>
    <dl>${requestDetailsHtml(data)}</dl>
    <p>We will email you as soon as your appointment is approved.</p>
  </body>
</html>`;
}

function requestReceivedText(data) {
  return [
    TEST_BANNER,
    "Kai Lani Bodywork & Wellness",
    `Hi ${data.firstName},`,
    "Your appointment request was sent. Chelsea will review your requested time. Your appointment is not confirmed until you receive an approval email.",
    `Service: ${data.serviceName} (${data.durationMinutes} min)`,
    `Date and time: ${formatDateTime(data.startAt)}`,
    `Price: ${dollars(Number(data.price))}`,
    `Request reference: ${data.requestId}`,
    "We will email you as soon as your appointment is approved.",
  ].join("\n");
}

function approvalEmailHtml(data) {
  const approvalUrl = escapeHtml(data.approvalUrl);
  return `<!doctype html>
<html>
  <body style="font-family: Arial, sans-serif; color: #1f2d2f; line-height: 1.5;">
    <div style="border: 2px solid #b85c38; padding: 12px; margin-bottom: 18px; font-weight: 700;">${TEST_BANNER}</div>
    <h1>New appointment request awaiting approval</h1>
    <dl>
      <dt>Client</dt><dd>${escapeHtml(data.firstName)} ${escapeHtml(data.lastName)}</dd>
      <dt>Client email</dt><dd>${escapeHtml(data.email)}</dd>
      <dt>Client phone</dt><dd>${escapeHtml(data.phone)}</dd>
      ${requestDetailsHtml(data)}
    </dl>
    <p>Approve this request by opening the link below. You can also decline it from the review page.</p>
    <p><a href="${approvalUrl}">Review and approve this appointment request</a></p>
    <p>${approvalUrl}</p>
  </body>
</html>`;
}

function approvalEmailText(data) {
  return [
    TEST_BANNER,
    "New appointment request awaiting approval",
    `Client: ${data.firstName} ${data.lastName}`,
    `Client email: ${data.email}`,
    `Client phone: ${data.phone}`,
    `Service: ${data.serviceName} (${data.durationMinutes} min)`,
    `Date and time: ${formatDateTime(data.startAt)}`,
    `Request reference: ${data.requestId}`,
    "Approve this request by opening the link below. You can also decline it from the review page.",
    data.approvalUrl,
  ].join("\n");
}

function approvedClientHtml(data) {
  const dateTime = escapeHtml(formatDateTime(data.startAt));
  const calendarUrl = escapeHtml(data.calendarUrl);
  return `<!doctype html>
<html>
  <body style="font-family: Arial, sans-serif; color: #1f2d2f; line-height: 1.5;">
    <div style="border: 2px solid #b85c38; padding: 12px; margin-bottom: 18px; font-weight: 700;">${TEST_BANNER}</div>
    <h1>Kai Lani Bodywork &amp; Wellness</h1>
    <p>Hi ${escapeHtml(data.firstName)},</p>
    <p>Good news! Your appointment is confirmed.</p>
    <dl>
      <dt>Service</dt><dd>${escapeHtml(data.serviceName)} (${escapeHtml(data.durationMinutes)} min)</dd>
      <dt>Date and time</dt><dd>${dateTime}</dd>
      <dt>Booking reference</dt><dd>${escapeHtml(data.bookingId)}</dd>
      <dt>Location</dt><dd>${escapeHtml(LOCATION)}</dd>
      <dt>Phone</dt><dd>${escapeHtml(BUSINESS_PHONE)}</dd>
    </dl>
    <p><a href="${calendarUrl}">Add this appointment to Google Calendar</a></p>
    <h2>Arrival instructions</h2>
    <p>${escapeHtml(ARRIVAL_INSTRUCTIONS)}</p>
    <p>A calendar invitation is attached to this email (kai-lani-appointment.ics).</p>
  </body>
</html>`;
}

function approvedClientText(data) {
  return [
    TEST_BANNER,
    "Kai Lani Bodywork & Wellness",
    `Hi ${data.firstName},`,
    "Good news! Your appointment is confirmed.",
    `Service: ${data.serviceName} (${data.durationMinutes} min)`,
    `Date and time: ${formatDateTime(data.startAt)}`,
    `Booking reference: ${data.bookingId}`,
    `Location: ${LOCATION}`,
    `Phone: ${BUSINESS_PHONE}`,
    `Add this appointment to Google Calendar: ${data.calendarUrl}`,
    `Arrival instructions: ${ARRIVAL_INSTRUCTIONS}`,
    "A calendar invitation is attached to this email (kai-lani-appointment.ics).",
  ].join("\n");
}

function approvedProviderHtml(data) {
  return `<!doctype html>
<html>
  <body style="font-family: Arial, sans-serif; color: #1f2d2f; line-height: 1.5;">
    <div style="border: 2px solid #b85c38; padding: 12px; margin-bottom: 18px; font-weight: 700;">${TEST_BANNER}</div>
    <h1>Appointment approved</h1>
    <dl>
      <dt>Client</dt><dd>${escapeHtml(data.firstName)} ${escapeHtml(data.lastName)}</dd>
      <dt>Client email</dt><dd>${escapeHtml(data.email)}</dd>
      <dt>Client phone</dt><dd>${escapeHtml(data.phone)}</dd>
      <dt>Service</dt><dd>${escapeHtml(data.serviceName)} (${escapeHtml(data.durationMinutes)} min)</dd>
      <dt>Date and time</dt><dd>${escapeHtml(formatDateTime(data.startAt))}</dd>
      <dt>Booking reference</dt><dd>${escapeHtml(data.bookingId)}</dd>
    </dl>
    <p>A calendar invitation is attached to this email (kai-lani-appointment.ics).</p>
  </body>
</html>`;
}

function approvedProviderText(data) {
  return [
    TEST_BANNER,
    "Appointment approved",
    `Client: ${data.firstName} ${data.lastName}`,
    `Client email: ${data.email}`,
    `Client phone: ${data.phone}`,
    `Service: ${data.serviceName} (${data.durationMinutes} min)`,
    `Date and time: ${formatDateTime(data.startAt)}`,
    `Booking reference: ${data.bookingId}`,
    "A calendar invitation is attached to this email (kai-lani-appointment.ics).",
  ].join("\n");
}

function declinedClientHtml(data) {
  return `<!doctype html>
<html>
  <body style="font-family: Arial, sans-serif; color: #1f2d2f; line-height: 1.5;">
    <div style="border: 2px solid #b85c38; padding: 12px; margin-bottom: 18px; font-weight: 700;">${TEST_BANNER}</div>
    <h1>Kai Lani Bodywork &amp; Wellness</h1>
    <p>Hi ${escapeHtml(data.firstName)},</p>
    <p>Chelsea was unable to approve your requested appointment time.</p>
    <dl>${requestDetailsHtml(data)}</dl>
    <p>You are welcome to request a different time that works for you.</p>
  </body>
</html>`;
}

function declinedClientText(data) {
  return [
    TEST_BANNER,
    "Kai Lani Bodywork & Wellness",
    `Hi ${data.firstName},`,
    "Chelsea was unable to approve your requested appointment time.",
    `Service: ${data.serviceName} (${data.durationMinutes} min)`,
    `Date and time: ${formatDateTime(data.startAt)}`,
    `Request reference: ${data.requestId}`,
    "You are welcome to request a different time that works for you.",
  ].join("\n");
}

function needsRescheduleHtml(data) {
  return `<!doctype html>
<html>
  <body style="font-family: Arial, sans-serif; color: #1f2d2f; line-height: 1.5;">
    <div style="border: 2px solid #b85c38; padding: 12px; margin-bottom: 18px; font-weight: 700;">${TEST_BANNER}</div>
    <h1>Kai Lani Bodywork &amp; Wellness</h1>
    <p>Hi ${escapeHtml(data.firstName)},</p>
    <p>The appointment time you requested is no longer available.</p>
    <dl>${requestDetailsHtml(data)}</dl>
    <p>Please request a new time that works for you.</p>
  </body>
</html>`;
}

function needsRescheduleText(data) {
  return [
    TEST_BANNER,
    "Kai Lani Bodywork & Wellness",
    `Hi ${data.firstName},`,
    "The appointment time you requested is no longer available.",
    `Service: ${data.serviceName} (${data.durationMinutes} min)`,
    `Date and time: ${formatDateTime(data.startAt)}`,
    `Request reference: ${data.requestId}`,
    "Please request a new time that works for you.",
  ].join("\n");
}

function approvedAppointmentAttachment(request) {
  return buildIcsAttachment({
    bookingId: request.bookingId,
    serviceName: request.serviceName,
    duration: request.durationMinutes,
    startAt: request.startAt,
  });
}

export async function sendBookingRequestReceivedEmail(request) {
  const requestId = String(request.requestId || "");
  const data = requestData(request);
  return postResend(
    basePayload(
      "[SANDBOX] We received your appointment request",
      requestReceivedHtml(data),
      requestReceivedText(data),
    ),
    `kai-lani/request-receipt/${requestId}`,
    { type: "request-receipt", bookingSuffix: requestSuffix(requestId) },
  );
}

export async function sendApprovalEmail(request) {
  const requestId = String(request.requestId || "");
  const data = requestData(request);
  if (!data.approvalUrl) {
    console.info(
      `Email notification type=approval bookingSuffix=${requestSuffix(requestId)} status=failed reason=approval_url_not_configured`,
    );
    return "failed";
  }
  return postResend(
    basePayload(
      "[SANDBOX] New appointment request awaiting approval",
      approvalEmailHtml(data),
      approvalEmailText(data),
    ),
    `kai-lani/approval/${requestId}`,
    { type: "approval", bookingSuffix: requestSuffix(requestId) },
  );
}

export async function sendApprovedClientEmail(request) {
  const requestId = String(request.requestId || "");
  const data = requestData(request);
  return postResend(
    basePayload(
      "[SANDBOX] Your appointment is confirmed",
      approvedClientHtml(data),
      approvedClientText(data),
      [approvedAppointmentAttachment(data)],
    ),
    `kai-lani/approved-client/${requestId}`,
    { type: "approved-client", bookingSuffix: requestSuffix(requestId) },
  );
}

export async function sendApprovedProviderEmail(request) {
  const requestId = String(request.requestId || "");
  const data = requestData(request);
  return postResend(
    basePayload(
      "[SANDBOX] Appointment approved",
      approvedProviderHtml(data),
      approvedProviderText(data),
      [approvedAppointmentAttachment(data)],
    ),
    `kai-lani/approved-provider/${requestId}`,
    { type: "approved-provider", bookingSuffix: requestSuffix(requestId) },
  );
}

export async function sendDeclinedClientEmail(request) {
  const requestId = String(request.requestId || "");
  const data = requestData(request);
  return postResend(
    basePayload(
      "[SANDBOX] Your appointment request was not approved",
      declinedClientHtml(data),
      declinedClientText(data),
    ),
    `kai-lani/declined-client/${requestId}`,
    { type: "declined-client", bookingSuffix: requestSuffix(requestId) },
  );
}

export async function sendNeedsRescheduleEmail(request) {
  const requestId = String(request.requestId || "");
  const data = requestData(request);
  return postResend(
    basePayload(
      "[SANDBOX] That time is no longer available",
      needsRescheduleHtml(data),
      needsRescheduleText(data),
    ),
    `kai-lani/needs-reschedule/${requestId}`,
    { type: "needs-reschedule", bookingSuffix: requestSuffix(requestId) },
  );
}

export const emailTestInternals = {
  ARRIVAL_INSTRUCTIONS,
  BUSINESS_PHONE,
  LOCATION,
  TEST_BANNER,
  clientHtml,
  clientText,
  providerHtml,
  providerText,
  formatDateTime,
  approvedClientHtml,
  approvedClientText,
  approvedProviderHtml,
  approvedProviderText,
  approvalEmailHtml,
  approvalEmailText,
  declinedClientHtml,
  declinedClientText,
  needsRescheduleHtml,
  needsRescheduleText,
  requestReceivedHtml,
  requestReceivedText,
};
