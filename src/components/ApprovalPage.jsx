import { useEffect, useState } from "react";
import { publicRequestReference } from "../lib/request-reference.js";
import "./ApprovalPage.css";

/*
 * Approval page for the booking-request workflow.
 *
 * Chelsea opens the emailed approval link (/approve?token=...), the SPA reads
 * the token and immediately strips it from the address bar via
 * history.replaceState, then the server handler serves the request summary and
 * performs the approve/decline pivot. The token is never rendered and never
 * returned by any API.
 */

const SUMMARY_URL = "/api/square/booking-requests/approve";
const APPROVE_URL = "/api/square/booking-requests/approve";
const DECLINE_URL = "/api/square/booking-requests/decline";

function formatDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
}

const PENDING_SQUARE_MESSAGE =
  "The appointment is pending acceptance in Square. Open Square Dashboard, accept the pending appointment, then return here and check its status.";

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export default function ApprovalPage() {
  const [token] = useState(() => {
    if (typeof window === "undefined") return "";
    return new URLSearchParams(window.location.search).get("token") || "";
  });

  const [phase, setPhase] = useState("loading");
  const [request, setRequest] = useState(null);
  const [outcome, setOutcome] = useState(null);
  const [errorMessage, setErrorMessage] = useState(null);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    history.replaceState({}, "", "/approve");
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!token) {
      setPhase("done");
      setErrorMessage("This approval link is invalid.");
      return () => {
        cancelled = true;
      };
    }

    async function load() {
      try {
        const res = await fetch(
          `${SUMMARY_URL}?token=${encodeURIComponent(token)}`,
        );
        const data = await readJson(res);
        if (cancelled) return;
        if (!res.ok) {
          setPhase("done");
          setErrorMessage(data?.error || "This approval link is invalid or has expired.");
          return;
        }
        setRequest(data);
        if (data.decided) {
          setOutcome({
            status: data.status,
            message:
              data.status === "approved"
                ? "Your appointment is confirmed."
                : data.status === "awaiting_square_acceptance"
                  ? PENDING_SQUARE_MESSAGE
                : data.status === "declined"
                  ? "This appointment request was declined."
                  : data.status === "failed"
                    ? "This request could not be processed. Please start a new request."
                    : "That time is no longer available.",
          });
          setPhase("done");
          return;
        }
        setPhase("summary");
      } catch {
        if (!cancelled) {
          setPhase("done");
          setErrorMessage("Could not load this request right now. Please try again.");
        }
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function decide(url) {
    setPhase("working");
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const data = await readJson(res);
      setOutcome(data || { status: "unknown" });
      setPhase("done");
    } catch {
      setPhase("summary");
      setErrorMessage("Could not complete that action right now. Please try again.");
    }
  }

  const pendingSummary = request && (
    <dl className="ap-details">
      <div>
        <dt>Client</dt>
        <dd>
          {request.firstName} {request.lastName}
        </dd>
      </div>
      <div>
        <dt>Email</dt>
        <dd>{request.email}</dd>
      </div>
      <div>
        <dt>Phone</dt>
        <dd>{request.phone}</dd>
      </div>
      <div>
        <dt>Service</dt>
        <dd>
          {request.serviceName} ({request.durationMinutes} min)
        </dd>
      </div>
      <div>
        <dt>Date and time</dt>
        <dd>{formatDateTime(request.startAt)}</dd>
      </div>
      <div>
        <dt>Request reference</dt>
        <dd>{publicRequestReference(request)}</dd>
      </div>
    </dl>
  );

  return (
    <div className="ap-page">
      <div className="ap-card">
        <header className="ap-header">
          <p className="ap-eyebrow">Kai Lani Bodywork &amp; Wellness</p>
          <h1 className="ap-title">
            {phase === "summary" ? "Review appointment request" : "Appointment request"}
          </h1>
        </header>

        {phase === "loading" && (
          <p className="ap-status" role="status">
            Loading request&hellip;
          </p>
        )}

        {phase === "summary" && request && (
          <>
            <p className="ap-lead">
              This appointment request is waiting for your approval.
            </p>
            {pendingSummary}
            <div className="ap-actions">
              <button
                type="button"
                className="ap-btn ap-btn-primary"
                onClick={() => decide(APPROVE_URL)}
              >
                {request.status === "awaiting_square_acceptance" ? "Check Square status" : "Approve request"}
              </button>
              {request.status !== "awaiting_square_acceptance" && (
                <button
                  type="button"
                  className="ap-btn ap-btn-ghost"
                  onClick={() => decide(DECLINE_URL)}
                >
                  Decline request
                </button>
              )}
            </div>
          </>
        )}

        {phase === "working" && (
          <p className="ap-status" role="status">
            Working&hellip;
          </p>
        )}

        {phase === "done" && errorMessage && (
          <p className="ap-message ap-message-error" role="alert">
            {errorMessage}
          </p>
        )}

        {phase === "done" && !errorMessage && outcome && (
          <div className="ap-result">
            <span className="ap-result-icon" aria-hidden="true">
              {outcome.status === "approved" ? (
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                  <path d="M22 4L12 14.01l-3-3" />
                </svg>
              ) : (
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <path d="M12 8v4" />
                  <path d="M12 16h.01" />
                </svg>
              )}
            </span>

            {outcome.status === "approved" && (
              <>
                <h2 className="ap-result-title">Appointment approved</h2>
                <p className="ap-result-message">{outcome.message}</p>
                <dl className="ap-details">
                  <div>
                    <dt>Service</dt>
                    <dd>{outcome.serviceName}</dd>
                  </div>
                  <div>
                    <dt>Date and time</dt>
                    <dd>{formatDateTime(outcome.startAt)}</dd>
                  </div>
                  {outcome.bookingId && (
                    <div>
                      <dt>Booking reference</dt>
                      <dd>{outcome.bookingId}</dd>
                    </div>
                  )}
                </dl>
                {outcome.calendarUrl && (
                  <p className="ap-calendar">
                    <a className="ap-btn ap-btn-primary ap-btn-link" href={outcome.calendarUrl} target="_blank" rel="noopener noreferrer">
                      Add this appointment to Google Calendar
                    </a>
                  </p>
                )}
              </>
            )}

            {outcome.status === "awaiting_square_acceptance" && (
              <>
                <h2 className="ap-result-title">Pending acceptance in Square</h2>
                <p className="ap-result-message">{outcome.message || PENDING_SQUARE_MESSAGE}</p>
                <div className="ap-actions">
                  <button
                    type="button"
                    className="ap-btn ap-btn-primary"
                    onClick={() => decide(APPROVE_URL)}
                  >
                    Check Square status
                  </button>
                </div>
              </>
            )}

            {outcome.status === "declined" && (
              <>
                <h2 className="ap-result-title">Appointment request declined</h2>
                <p className="ap-result-message">{outcome.message}</p>
              </>
            )}

            {outcome.status === "needs_reschedule" && (
              <>
                <h2 className="ap-result-title">Time no longer available</h2>
                <p className="ap-result-message">{outcome.message}</p>
              </>
            )}

            {outcome.status === "failed" && (
              <>
                <h2 className="ap-result-title">Request could not be processed</h2>
                <p className="ap-result-message">{outcome.message}</p>
              </>
            )}

            {outcome.status !== "approved" &&
              outcome.status !== "declined" &&
              outcome.status !== "needs_reschedule" &&
              outcome.status !== "failed" &&
              outcome.status !== "awaiting_square_acceptance" &&
              !errorMessage && (
                <p className="ap-result-message">This request could not be processed right now.</p>
              )}
          </div>
        )}
      </div>
    </div>
  );
}
