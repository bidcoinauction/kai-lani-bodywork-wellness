import { buildIcsAttachment } from "./calendar.js";
import { emailDeliveryMode } from "./environment.js";

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const EMAIL_TIMEOUT_MS = 8000;
const BOOKING_TIMEZONE = "America/New_York";
const ARRIVAL_INSTRUCTIONS =
  "From South Main Street, enter the narrow drive beside Uptown Salon and follow it behind the building. Look for the black staircase. The Suite F entrance is through the door just beyond the staircase on the main level. You do not need to go up the stairs.";

const LOCATION = "106 S Main St, Suite F, Mount Holly, NC 28120";
const BUSINESS_PHONE = "(980) 224-2462";
const TEST_BANNER = "TEST MESSAGE - NO REAL APPOINTMENT";

function hasEmailShape(value) {
  return typeof value === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function hasSender(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Resolves email delivery routing. Returns null (fail closed) unless:
 *   - EMAIL_ENABLED === "true"
 *   - the central booking-approval gate passes (BOOKING_APPROVAL_ENABLED,
 *     BOOKING_APPROVAL_MODE, SQUARE_ENVIRONMENT)
 *   - EMAIL_MODE matches the active environment exactly
 *   - RESEND_API_KEY and EMAIL_FROM are present
 *   - sandbox: EMAIL_SANDBOX_RECIPIENT is a valid address
 *   - production: CHELSEA_NOTIFICATION_EMAIL is a valid address
 *
 * The returned object is the single routing decision used by every send;
 * no caller duplicates mode checks.
 */
export function resolveEmailRouting() {
  const mode = emailDeliveryMode();
  if (!mode) return null;
  if (!process.env.RESEND_API_KEY) return null;
  if (!hasSender(process.env.EMAIL_FROM)) return null;

  if (mode === "sandbox") {
    if (!hasEmailShape(process.env.EMAIL_SANDBOX_RECIPIENT)) return null;
    return { mode: "sandbox", sandboxRecipient: process.env.EMAIL_SANDBOX_RECIPIENT.trim() };
  }

  if (!hasEmailShape(process.env.CHELSEA_NOTIFICATION_EMAIL)) return null;
  return {
    mode: "production",
    chelseaRecipient: process.env.CHELSEA_NOTIFICATION_EMAIL.trim(),
  };
}

/**
 * The recipient for a message kind under the resolved routing. Returns null
 * (fail closed) when the destination cannot be safely determined.
 *
 *   kind "client":  sandbox -> sandbox mailbox; production -> the validated
 *                   client email supplied by the approved request.
 *   kind "chelsea": sandbox -> sandbox mailbox; production -> the configured
 *                   CHELSEA_NOTIFICATION_EMAIL only.
 *
 * Sandbox never sends to the real client or Chelsea; production never uses
 * EMAIL_SANDBOX_RECIPIENT. Recipients are never logged.
 */
export function recipientFor(routing, kind, request) {
  if (!routing) return null;
  if (routing.mode === "sandbox") return routing.sandboxRecipient;
  if (kind === "chelsea") return routing.chelseaRecipient;
  const clientEmail = String(request?.email || "").trim().toLowerCase();
  return hasEmailShape(clientEmail) ? clientEmail : null;
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

/**
 * SANDBOX banner that proves a message is a test. Omitted entirely in
 * production.
 */
function sandboxBanner(sandbox) {
  if (!sandbox) return "";
  return `<div style="border: 2px solid #b85c38; padding: 12px; margin-bottom: 18px; font-weight: 700;">${TEST_BANNER}</div>`;
}

function clientHtml(data, sandbox = false) {
  const dateTime = escapeHtml(formatDateTime(data.startAt));
  return `<!doctype html>
<html>
  <body style="font-family: Arial, sans-serif; color: #1f2d2f; line-height: 1.5;">
    ${sandboxBanner(sandbox)}
    <h1>Kai Lani Bodywork &amp; Wellness</h1>
    ${sandbox ? "<p>This is a Square Sandbox test confirmation. No real appointment was created.</p>" : ""}
    <p>Hi ${escapeHtml(data.firstName)},</p>
    <p>Your booking details are below.</p>
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

function clientText(data, sandbox = false) {
  const lines = [];
  if (sandbox) {
    lines.push(TEST_BANNER);
    lines.push("Kai Lani Bodywork & Wellness");
    lines.push("This is a Square Sandbox test confirmation. No real appointment was created.");
  } else {
    lines.push("Kai Lani Bodywork & Wellness");
  }
  lines.push(
    `Hi ${data.firstName},`,
    `Service: ${data.serviceName} (${data.duration} min)`,
    `Date and time: ${formatDateTime(data.startAt)}`,
    `Price: ${dollars(data.price)}`,
    `Booking reference: ${data.bookingId}`,
    `Location: ${LOCATION}`,
    `Arrival instructions: ${ARRIVAL_INSTRUCTIONS}`,
    `Phone: ${BUSINESS_PHONE}`,
    `Reply-to: ${data.replyTo}`,
  );
  return lines.join("\n");
}

function providerHtml(data, sandbox = false) {
  const dateTime = escapeHtml(formatDateTime(data.startAt));
  return `<!doctype html>
<html>
  <body style="font-family: Arial, sans-serif; color: #1f2d2f; line-height: 1.5;">
    ${sandboxBanner(sandbox)}
    <h1>New Kai Lani appointment</h1>
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

function providerText(data, sandbox = false) {
  const lines = sandbox
    ? [TEST_BANNER, "New Kai Lani test appointment"]
    : ["New Kai Lani appointment"];
  lines.push(
    `Client: ${data.firstName} ${data.lastName}`,
    `Service: ${data.serviceName} (${data.duration} min)`,
    `Date and time: ${formatDateTime(data.startAt)}`,
    `Client email: ${data.email}`,
    `Client phone: ${data.phone}`,
    `Booking reference: ${data.bookingId}`,
  );
  return lines.join("\n");
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

function basePayload(routing, to, subject, html, text, attachments) {
  const payload = {
    from: process.env.EMAIL_FROM,
    to: [to],
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

function subjectPrefix(routing) {
  return routing.mode === "sandbox" ? "[SANDBOX] " : "";
}

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
    `<dt>Request reference</dt><dd>${escapeHtml(data.requestKey || data.requestId)}</dd>`,
  ]
    .filter(Boolean)
    .join("");
}

function requestReceivedHtml(data, sandbox = false) {
  return `<!doctype html>
<html>
  <body style="font-family: Arial, sans-serif; color: #1f2d2f; line-height: 1.5;">
    ${sandboxBanner(sandbox)}
    <h1>Kai Lani Bodywork &amp; Wellness</h1>
    <p>Hi ${escapeHtml(data.firstName)},</p>
    <p>Your appointment request was sent. Chelsea will review your requested time. Your appointment is not confirmed until you receive an approval email.</p>
    <dl>${requestDetailsHtml(data)}</dl>
    <p>We will email you as soon as your appointment is approved.</p>
  </body>
</html>`;
}

function requestReceivedText(data, sandbox = false) {
  const lines = sandbox
    ? [TEST_BANNER]
    : ["Kai Lani Bodywork & Wellness"];
  lines.push(
    `Hi ${data.firstName},`,
    "Your appointment request was sent. Chelsea will review your requested time. Your appointment is not confirmed until you receive an approval email.",
    `Service: ${data.serviceName} (${data.durationMinutes} min)`,
    `Date and time: ${formatDateTime(data.startAt)}`,
    `Price: ${dollars(Number(data.price))}`,
    `Request reference: ${data.requestKey || data.requestId}`,
    "We will email you as soon as your appointment is approved.",
  );
  return lines.join("\n");
}

function approvalEmailHtml(data, sandbox = false) {
  const approvalUrl = escapeHtml(data.approvalUrl);
  return `<!doctype html>
<html>
  <body style="font-family: Arial, sans-serif; color: #1f2d2f; line-height: 1.5;">
    ${sandboxBanner(sandbox)}
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

function approvalEmailText(data, sandbox = false) {
  const lines = sandbox
    ? [TEST_BANNER]
    : ["New appointment request awaiting approval"];
  lines.push(
    `Client: ${data.firstName} ${data.lastName}`,
    `Client email: ${data.email}`,
    `Client phone: ${data.phone}`,
    `Service: ${data.serviceName} (${data.durationMinutes} min)`,
    `Date and time: ${formatDateTime(data.startAt)}`,
    `Request reference: ${data.requestKey || data.requestId}`,
    "Approve this request by opening the link below. You can also decline it from the review page.",
    data.approvalUrl,
  );
  return lines.join("\n");
}

function approvedClientHtml(data, sandbox = false) {
  const dateTime = escapeHtml(formatDateTime(data.startAt));
  const calendarUrl = escapeHtml(data.calendarUrl);
  const paymentUrl = data.paymentUrl ? escapeHtml(data.paymentUrl) : "";
  return `<!doctype html>
<html>
  <body style="font-family: Arial, sans-serif; color: #1f2d2f; line-height: 1.5;">
    ${sandboxBanner(sandbox)}
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
    ${paymentUrl ? `<h2>Payment</h2>
    <p>Prefer to take care of payment ahead of time?</p>
    <p>You can securely prepay through Square, or pay at your appointment.</p>
    <p><a href="${paymentUrl}" style="display:inline-block; background:#0a1f24; color:#ffffff; padding:12px 18px; border-radius:8px; text-decoration:none; font-weight:700;">Pay now securely with Square</a></p>
    <p>You can also pay at your appointment.</p>` : ""}
    <h2>Arrival instructions</h2>
    <p>${escapeHtml(ARRIVAL_INSTRUCTIONS)}</p>
    <p>A calendar invitation is attached to this email (kai-lani-appointment.ics).</p>
  </body>
</html>`;
}

function approvedClientText(data, sandbox = false) {
  const lines = sandbox
    ? [TEST_BANNER]
    : ["Kai Lani Bodywork & Wellness"];
  lines.push(
    `Hi ${data.firstName},`,
    "Good news! Your appointment is confirmed.",
    `Service: ${data.serviceName} (${data.durationMinutes} min)`,
    `Date and time: ${formatDateTime(data.startAt)}`,
    `Booking reference: ${data.bookingId}`,
    `Location: ${LOCATION}`,
    `Phone: ${BUSINESS_PHONE}`,
    `Add this appointment to Google Calendar: ${data.calendarUrl}`,
    ...(data.paymentUrl ? [
      "Payment",
      "Prefer to take care of payment ahead of time?",
      "You can securely prepay through Square, or pay at your appointment.",
      `Pay now securely with Square: ${data.paymentUrl}`,
      "You can also pay at your appointment.",
    ] : []),
    `Arrival instructions: ${ARRIVAL_INSTRUCTIONS}`,
    "A calendar invitation is attached to this email (kai-lani-appointment.ics).",
  );
  return lines.join("\n");
}

function approvedProviderHtml(data, sandbox = false) {
  const dateTime = escapeHtml(formatDateTime(data.startAt));
  return `<!doctype html>
<html>
  <body style="font-family: Arial, sans-serif; color: #1f2d2f; line-height: 1.5;">
    ${sandboxBanner(sandbox)}
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

function approvedProviderText(data, sandbox = false) {
  const lines = sandbox
    ? [TEST_BANNER]
    : ["Appointment approved"];
  lines.push(
    `Client: ${data.firstName} ${data.lastName}`,
    `Client email: ${data.email}`,
    `Client phone: ${data.phone}`,
    `Service: ${data.serviceName} (${data.durationMinutes} min)`,
    `Date and time: ${formatDateTime(data.startAt)}`,
    `Booking reference: ${data.bookingId}`,
    "A calendar invitation is attached to this email (kai-lani-appointment.ics).",
  );
  return lines.join("\n");
}

function declinedClientHtml(data, sandbox = false) {
  return `<!doctype html>
<html>
  <body style="font-family: Arial, sans-serif; color: #1f2d2f; line-height: 1.5;">
    ${sandboxBanner(sandbox)}
    <h1>Kai Lani Bodywork &amp; Wellness</h1>
    <p>Hi ${escapeHtml(data.firstName)},</p>
    <p>Chelsea was unable to approve your requested appointment time.</p>
    <dl>${requestDetailsHtml(data)}</dl>
    <p>You are welcome to request a different time that works for you.</p>
  </body>
</html>`;
}

function declinedClientText(data, sandbox = false) {
  const lines = sandbox
    ? [TEST_BANNER]
    : ["Kai Lani Bodywork & Wellness"];
  lines.push(
    `Hi ${data.firstName},`,
    "Chelsea was unable to approve your requested appointment time.",
    `Service: ${data.serviceName} (${data.durationMinutes} min)`,
    `Date and time: ${formatDateTime(data.startAt)}`,
    `Request reference: ${data.requestKey || data.requestId}`,
    "You are welcome to request a different time that works for you.",
  );
  return lines.join("\n");
}

function needsRescheduleHtml(data, sandbox = false) {
  return `<!doctype html>
<html>
  <body style="font-family: Arial, sans-serif; color: #1f2d2f; line-height: 1.5;">
    ${sandboxBanner(sandbox)}
    <h1>Kai Lani Bodywork &amp; Wellness</h1>
    <p>Hi ${escapeHtml(data.firstName)},</p>
    <p>The appointment time you requested is no longer available.</p>
    <dl>${requestDetailsHtml(data)}</dl>
    <p>Please request a new time that works for you.</p>
  </body>
</html>`;
}

function needsRescheduleText(data, sandbox = false) {
  const lines = sandbox
    ? [TEST_BANNER]
    : ["Kai Lani Bodywork & Wellness"];
  lines.push(
    `Hi ${data.firstName},`,
    "The appointment time you requested is no longer available.",
    `Service: ${data.serviceName} (${data.durationMinutes} min)`,
    `Date and time: ${formatDateTime(data.startAt)}`,
    `Request reference: ${data.requestKey || data.requestId}`,
    "Please request a new time that works for you.",
  );
  return lines.join("\n");
}

/**
 * Single delivery helper: resolves routing, computes the destination for the
 * message kind, builds the payload with the correct subject prefix and
 * sandbox banner, and sends with the deterministic idempotency key. Performs
 * no fetch and returns "disabled" whenever configuration or recipient routing
 * does not fully resolve (fail closed).
 */
async function deliver({
  routing,
  kind,
  request,
  subject,
  htmlBuilder,
  textBuilder,
  idempotencyKey,
  metadata,
  attachments,
}) {
  if (!routing) {
    logEmailStatus(metadata, "disabled");
    return "disabled";
  }
  const to = recipientFor(routing, kind, request);
  if (!to) {
    logEmailStatus(metadata, "disabled");
    return "disabled";
  }

  const sandbox = routing.mode === "sandbox";
  const data = requestData(request);
  const payload = basePayload(
    routing,
    to,
    `${subjectPrefix(routing)}${subject}`,
    htmlBuilder(data, sandbox),
    textBuilder(data, sandbox),
    attachments,
  );
  return postResend(payload, idempotencyKey, metadata);
}

export async function sendBookingNotifications(booking) {
  const bookingId = String(booking.bookingId || "");
  const suffix = bookingSuffix(bookingId);
  const routing = resolveEmailRouting();

  const client = await deliver({
    routing,
    kind: "client",
    request: booking,
    subject: "Kai Lani booking confirmation",
    htmlBuilder: clientHtml,
    textBuilder: clientText,
    idempotencyKey: `kai-lani/client-confirmation/${bookingId}`,
    metadata: { type: "client-confirmation", bookingSuffix: suffix },
  });

  const provider = await deliver({
    routing,
    kind: "chelsea",
    request: booking,
    subject: "New Kai Lani appointment",
    htmlBuilder: providerHtml,
    textBuilder: providerText,
    idempotencyKey: `kai-lani/provider-notification/${bookingId}`,
    metadata: { type: "provider-notification", bookingSuffix: suffix },
  });

  return { client, provider };
}

export async function sendBookingRequestReceivedEmail(request) {
  const requestId = String(request.requestId || "");
  const routing = resolveEmailRouting();
  return deliver({
    routing,
    kind: "client",
    request,
    subject: "We received your appointment request",
    htmlBuilder: requestReceivedHtml,
    textBuilder: requestReceivedText,
    idempotencyKey: `kai-lani/request-receipt/${requestId}`,
    metadata: { type: "request-receipt", bookingSuffix: requestSuffix(requestId) },
  });
}

export async function sendApprovalEmail(request) {
  const requestId = String(request.requestId || "");
  const routing = resolveEmailRouting();
  if (!request.approvalUrl) {
    console.info(
      `Email notification type=approval bookingSuffix=${requestSuffix(requestId)} status=failed reason=approval_url_not_configured`,
    );
    return "failed";
  }
  return deliver({
    routing,
    kind: "chelsea",
    request,
    subject: "New appointment request awaiting approval",
    htmlBuilder: approvalEmailHtml,
    textBuilder: approvalEmailText,
    idempotencyKey: `kai-lani/approval/${requestId}`,
    metadata: { type: "approval", bookingSuffix: requestSuffix(requestId) },
  });
}

function approvedAppointmentAttachment(request) {
  return buildIcsAttachment({
    bookingId: request.bookingId,
    serviceName: request.serviceName,
    duration: request.durationMinutes,
    startAt: request.startAt,
  });
}

export async function sendApprovedClientEmail(request) {
  const requestId = String(request.requestId || "");
  const routing = resolveEmailRouting();
  return deliver({
    routing,
    kind: "client",
    request,
    subject: "Your appointment is confirmed",
    htmlBuilder: approvedClientHtml,
    textBuilder: approvedClientText,
    idempotencyKey: `kai-lani/approved-client/${requestId}`,
    metadata: { type: "approved-client", bookingSuffix: requestSuffix(requestId) },
    attachments: [approvedAppointmentAttachment(request)],
  });
}

export async function sendApprovedProviderEmail(request) {
  const requestId = String(request.requestId || "");
  const routing = resolveEmailRouting();
  return deliver({
    routing,
    kind: "chelsea",
    request,
    subject: "Appointment approved",
    htmlBuilder: approvedProviderHtml,
    textBuilder: approvedProviderText,
    idempotencyKey: `kai-lani/approved-provider/${requestId}`,
    metadata: { type: "approved-provider", bookingSuffix: requestSuffix(requestId) },
    attachments: [approvedAppointmentAttachment(request)],
  });
}

export async function sendDeclinedClientEmail(request) {
  const requestId = String(request.requestId || "");
  const routing = resolveEmailRouting();
  return deliver({
    routing,
    kind: "client",
    request,
    subject: "Your appointment request was not approved",
    htmlBuilder: declinedClientHtml,
    textBuilder: declinedClientText,
    idempotencyKey: `kai-lani/declined-client/${requestId}`,
    metadata: { type: "declined-client", bookingSuffix: requestSuffix(requestId) },
  });
}

export async function sendNeedsRescheduleEmail(request) {
  const requestId = String(request.requestId || "");
  const routing = resolveEmailRouting();
  return deliver({
    routing,
    kind: "client",
    request,
    subject: "That time is no longer available",
    htmlBuilder: needsRescheduleHtml,
    textBuilder: needsRescheduleText,
    idempotencyKey: `kai-lani/needs-reschedule/${requestId}`,
    metadata: { type: "needs-reschedule", bookingSuffix: requestSuffix(requestId) },
  });
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
