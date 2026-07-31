import { useState, useRef } from "react";
import "./SquareBooking.css";

/*
 * Square Appointments sandbox booking flow (4 steps):
 *   Service -> Date -> Time -> Details & confirm
 *
 * Rendered only when VITE_ENABLE_SQUARE_SANDBOX is "true" (Vercel Preview).
 * The compact "Sandbox preview" pill keeps it clearly separate from
 * production booking. This component never imports the Square server client.
 */

const BOOKING_TIMEZONE = "America/New_York";
const BOOKING_WINDOW_DAYS = 14;

const SQUARE_SERVICES = [
  {
    key: "customized_60",
    name: "60 Min Customized Massage",
    duration: "60 min",
    price: "$93",
    description:
      "A deeply personalized session tailored to your body\u2019s unique needs using a blend of intuitive touch and targeted techniques.",
  },
  {
    key: "deep_tissue_60",
    name: "60 Min Customized Deep Tissue Massage",
    duration: "60 min",
    price: "$93",
    description:
      "Focused deep tissue work to relieve severe tension and improve range of motion.",
  },
  {
    key: "prenatal_60",
    name: "60 Min Customized Prenatal Massage",
    duration: "60 min",
    price: "$97",
    description:
      "Safe, supportive prenatal massage for comfort and relaxation during pregnancy.",
  },
  {
    key: "customized_90",
    name: "90 Min Customized Massage",
    duration: "90 min",
    price: "$123",
    description: "Extended session for deeper relaxation and fuller restoration.",
  },
  {
    key: "deep_tissue_90",
    name: "90 Min Customized Deep Tissue Massage",
    duration: "90 min",
    price: "$123",
    description:
      "Extended deep tissue session for complex tension patterns and full-body recovery.",
  },
];

const STEP_GROUPS = [
  { label: "60-minute sessions", services: SQUARE_SERVICES.filter((s) => s.duration === "60 min") },
  { label: "90-minute sessions", services: SQUARE_SERVICES.filter((s) => s.duration === "90 min") },
];

function nyFormat(date, options) {
  return new Intl.DateTimeFormat("en-US", { ...options, timeZone: BOOKING_TIMEZONE }).format(date);
}

function nyDateString(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: BOOKING_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function dateStringToUtc(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
}

function getDateOptions() {
  const today = nyDateString(new Date());
  const options = [];
  for (let i = 0; i < BOOKING_WINDOW_DAYS; i += 1) {
    const utc = new Date(dateStringToUtc(today).getTime() + i * 86400000);
    options.push({
      dateStr: nyDateString(utc),
      weekday: nyFormat(utc, { weekday: "short" }),
      dayOfMonth: nyFormat(utc, { day: "numeric" }),
      monthShort: nyFormat(utc, { month: "short" }),
      isToday: i === 0,
    });
  }
  return options;
}

function formatDateLabel(dateStr) {
  return nyFormat(dateStringToUtc(dateStr), {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

function makeIdempotencyKey() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const rand = () => Math.random().toString(36).slice(2, 10);
  return `kl-${rand()}${rand()}`;
}

const STEP_META = {
  service: { label: "Service", heading: "Choose your session." },
  date: { label: "Date", heading: "Pick a day." },
  time: { label: "Time", heading: "Pick a time." },
  contact: { label: "Details", heading: "Your details." },
  confirm: { label: "Confirmation", heading: "You\u2019re booked." },
};

const STEP_ORDER = ["service", "date", "time", "contact", "confirm"];

export default function SquareBooking() {
  const [step, setStep] = useState("service");
  const [serviceKey, setServiceKey] = useState(null);
  const [date, setDate] = useState(null);
  const [slots, setSlots] = useState([]);
  const [loadingSlots, setLoadingSlots] = useState(false);
  const [slotError, setSlotError] = useState(null);
  const [selectedSlot, setSelectedSlot] = useState(null);
  const [contact, setContact] = useState({ firstName: "", lastName: "", email: "", phone: "" });
  const [submitting, setSubmitting] = useState(false);
  const [bookingResult, setBookingResult] = useState(null);
  const [bookingError, setBookingError] = useState(null);
  const [statusMessage, setStatusMessage] = useState("");

  const idempotencyRef = useRef(null);

  const headingRefs = {
    service: useRef(null),
    date: useRef(null),
    time: useRef(null),
    contact: useRef(null),
    confirm: useRef(null),
  };

  function goTo(nextStep) {
    setStep(nextStep);
    requestAnimationFrame(() => headingRefs[nextStep]?.current?.focus());
  }

  const selectedService = SQUARE_SERVICES.find((s) => s.key === serviceKey) || null;

  function startOver() {
    setServiceKey(null);
    setDate(null);
    setSlots([]);
    setSelectedSlot(null);
    setContact({ firstName: "", lastName: "", email: "", phone: "" });
    setBookingResult(null);
    setBookingError(null);
    setSlotError(null);
    setStatusMessage("");
    idempotencyRef.current = null;
    goTo("service");
  }

  function selectService(key) {
    setServiceKey(key);
    setDate(null);
    setSlots([]);
    setSelectedSlot(null);
    setBookingError(null);
    setBookingResult(null);
    idempotencyRef.current = null;
  }

  function selectDate(dateStr) {
    setDate(dateStr);
    setSelectedSlot(null);
    setBookingError(null);
    setBookingResult(null);
    idempotencyRef.current = null;
  }

  async function continueToTime() {
    if (!serviceKey || !date) return;
    setLoadingSlots(true);
    setSlotError(null);
    setStatusMessage("Loading available times\u2026");
    try {
      const res = await fetch(
        `/api/square/availability?serviceKey=${encodeURIComponent(serviceKey)}&date=${encodeURIComponent(date)}`,
      );
      const data = await res.json().catch(() => null);
      if (!res.ok || !data) {
        throw new Error(data?.error || "Could not load availability.");
      }
      setSlots(Array.isArray(data.slots) ? data.slots : []);
      setStatusMessage("");
      goTo("time");
    } catch (error) {
      setSlotError(error?.message || "Could not load availability.");
      setStatusMessage("Could not load availability. Please try again.");
    } finally {
      setLoadingSlots(false);
    }
  }

  function selectSlot(slot) {
    setSelectedSlot(slot);
    setBookingError(null);
    setBookingResult(null);
    idempotencyRef.current = null;
  }

  function continueToContact() {
    if (!idempotencyRef.current) {
      idempotencyRef.current = makeIdempotencyKey();
    }
    goTo("contact");
  }

  function updateContact(field, value) {
    setContact((prev) => ({ ...prev, [field]: value }));
  }

  async function submitBooking() {
    if (submitting) return;
    const trimmed = {
      firstName: contact.firstName.trim(),
      lastName: contact.lastName.trim(),
      email: contact.email.trim(),
      phone: contact.phone.trim(),
    };

    if (!trimmed.firstName || !trimmed.lastName) {
      setBookingError("Please enter your first and last name.");
      return;
    }
    if (!/^\S+@\S+\.\S+$/.test(trimmed.email)) {
      setBookingError("Please enter a valid email address.");
      return;
    }
    if (!/^\+?[\d\s().-]{10,16}$/.test(trimmed.phone)) {
      setBookingError("Please enter a valid phone number.");
      return;
    }

    if (!idempotencyRef.current) {
      idempotencyRef.current = makeIdempotencyKey();
    }

    setSubmitting(true);
    setBookingError(null);
    setStatusMessage("Creating your appointment\u2026");
    try {
      const res = await fetch("/api/square/create-booking", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serviceKey,
          startAt: selectedSlot.startAt,
          firstName: trimmed.firstName,
          lastName: trimmed.lastName,
          email: trimmed.email,
          phone: trimmed.phone,
          idempotencyKey: idempotencyRef.current,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data || !data.bookingId) {
        throw new Error(data?.error || "Could not create the appointment.");
      }
      setBookingResult(data);
      setStatusMessage("Appointment created.");
      goTo("confirm");
    } catch (error) {
      setBookingError(error?.message || "Could not create the appointment.");
      setStatusMessage("Could not create the appointment. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  const dateOptions = getDateOptions();
  const activeStep = STEP_META[step];

  const primaryDisabled =
    step === "service" ? !serviceKey
    : step === "date" ? !date
    : step === "time" ? !selectedSlot
    : step === "contact" ? submitting
    : true;

  const primaryLabel =
    step === "contact"
      ? submitting
        ? "Creating appointment\u2026"
        : "Confirm test booking"
      : "Continue";

  function handlePrimary() {
    if (step === "service" && serviceKey) goTo("date");
    else if (step === "date" && date) continueToTime();
    else if (step === "time" && selectedSlot) continueToContact();
  }

  const contactName = [contact.firstName.trim(), contact.lastName.trim()]
    .filter(Boolean)
    .join(" ");

  const summaryRows = [
    { key: "service", label: "Service", value: selectedService?.name, sub: selectedService?.duration },
    { key: "date", label: "Date", value: date ? formatDateLabel(date) : null },
    { key: "time", label: "Time", value: selectedSlot?.label || null },
    { key: "price", label: "Price", value: selectedService?.price || null },
  ];

  function goBack() {
    if (step === "date") goTo("service");
    else if (step === "time") goTo("date");
    else if (step === "contact") goTo("time");
  }

  return (
    <div className="sqb-shell">
      <header className="sqb-shell-header">
        <p className="sqb-eyebrow">Online booking</p>
        <h2 className="sqb-shell-title">Find a time that works for you.</h2>
        <p className="sqb-shell-copy">Choose your session, then select an available day and time.</p>
        <p className="sqb-sandbox-pill" role="note">
          Sandbox preview &mdash; test bookings only
        </p>
      </header>

      <p className="sqb-status" role="status" aria-live="polite">
        {statusMessage}
      </p>

      <ol className="sqb-steps" aria-label="Booking progress">
        {["service", "date", "time", "contact"].map((name, index) => {
          const meta = STEP_META[name];
          const isActive = step === name;
          const isDone = index < STEP_ORDER.indexOf(step);
          return (
            <li key={name} className={`sqb-step${isActive ? " is-active" : ""}${isDone ? " is-done" : ""}`}>
              <button
                type="button"
                className="sqb-step-btn"
                onClick={() => isDone && goTo(name)}
                disabled={!isDone}
                aria-current={isActive ? "step" : undefined}
                aria-label={`${meta.label}${isDone ? " (completed)" : ""}`}
              >
                <span className="sqb-step-index" aria-hidden="true">
                  {isDone ? (
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M20 6L9 17l-5-5" />
                    </svg>
                  ) : (
                    index + 1
                  )}
                </span>
                <span className="sqb-step-label">{meta.label}</span>
              </button>
            </li>
          );
        })}
      </ol>

      <p className="sqb-step-count" aria-hidden="true">
        Step {Math.min(STEP_ORDER.indexOf(step) + 1, 4)} of 4
      </p>

      <div className="sqb-layout">
        <div className="sqb-main">
          <div className="sqb-panel">
            {step !== "service" && step !== "confirm" && (
              <button type="button" className="sqb-back" onClick={goBack}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M19 12H5" />
                  <path d="M12 19l-7-7 7-7" />
                </svg>
                Back
              </button>
            )}

            <h3 className="sqb-heading" tabIndex={-1} ref={headingRefs[step]}>
              {activeStep.heading}
            </h3>

            {step === "service" && (
              <div className="sqb-service-groups">
                {STEP_GROUPS.map((group) => (
                  <div className="sqb-service-group" key={group.label}>
                    <p className="sqb-service-group-label">{group.label}</p>
                    <div className="sqb-service-grid" role="group" aria-label={group.label}>
                      {group.services.map((service) => {
                        const isSelected = serviceKey === service.key;
                        return (
                          <button
                            key={service.key}
                            type="button"
                            className={`sqb-service-card${isSelected ? " is-selected" : ""}`}
                            aria-pressed={isSelected}
                            onClick={() => selectService(service.key)}
                          >
                            <span className="sqb-service-select" aria-hidden="true">
                              {isSelected && (
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                                  <path d="M20 6L9 17l-5-5" />
                                </svg>
                              )}
                            </span>
                            <span className="sqb-service-name">{service.name}</span>
                            <span className="sqb-service-duration">{service.duration}</span>
                            <span className="sqb-service-desc">{service.description}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {step === "date" && (
              <div>
                <p className="sqb-date-hint">
                  Showing the next {BOOKING_WINDOW_DAYS} days (Eastern time).
                </p>
                <div className="sqb-date-grid" role="group" aria-label="Available dates">
                  {dateOptions.map((option) => {
                    const isSelected = date === option.dateStr;
                    return (
                      <button
                        key={option.dateStr}
                        type="button"
                        className={`sqb-date-cell${isSelected ? " is-selected" : ""}${option.isToday ? " is-today" : ""}`}
                        aria-pressed={isSelected}
                        onClick={() => selectDate(option.dateStr)}
                      >
                        <span className="sqb-date-weekday">
                          {option.isToday ? "Today" : option.weekday}
                        </span>
                        <span className="sqb-date-day">{option.dayOfMonth}</span>
                        <span className="sqb-date-month">{option.monthShort}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {step === "time" && (
              <div>
                <p className="sqb-time-date">
                  {date ? formatDateLabel(date) : ""}
                </p>

                {loadingSlots && <p className="sqb-message">Loading available times&hellip;</p>}

                {!loadingSlots && slotError && (
                  <div className="sqb-error-box" role="alert">
                    <p className="sqb-message sqb-error">{slotError}</p>
                    <button type="button" className="sqb-retry" onClick={continueToTime}>
                      Try again
                    </button>
                  </div>
                )}

                {!loadingSlots && !slotError && slots.length === 0 && (
                  <div className="sqb-empty">
                    <p className="sqb-message">No open times for this day. Please choose another date.</p>
                    <button type="button" className="sqb-retry" onClick={() => goTo("date")}>
                      Choose another day
                    </button>
                  </div>
                )}

                {!loadingSlots && !slotError && slots.length > 0 && (
                  <div className="sqb-time-grid" role="group" aria-label={`Available times on ${formatDateLabel(date)}`}>
                    {slots.map((slot) => {
                      const isSelected = selectedSlot?.startAt === slot.startAt;
                      return (
                        <button
                          key={slot.startAt}
                          type="button"
                          className={`sqb-time-cell${isSelected ? " is-selected" : ""}`}
                          aria-pressed={isSelected}
                          onClick={() => selectSlot(slot)}
                        >
                          {slot.label}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {step === "contact" && (
              <form
                className="sqb-form"
                id="sqb-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  submitBooking();
                }}
              >
                <div className="sqb-review" aria-label="Booking review">
                  <p className="sqb-review-title">Your appointment</p>
                  <dl className="sqb-review-list">
                    <div>
                      <dt>Service</dt>
                      <dd>{selectedService?.name}</dd>
                    </div>
                    <div>
                      <dt>Date &amp; time</dt>
                      <dd>
                        {date ? formatDateLabel(date) : "\u2014"} at {selectedSlot?.label || "\u2014"}
                      </dd>
                    </div>
                    <div>
                      <dt>Price</dt>
                      <dd>{selectedService?.price || "\u2014"}</dd>
                    </div>
                  </dl>
                </div>

                <fieldset className="sqb-fields">
                  <legend>Contact details</legend>
                  <div className="sqb-field">
                    <label htmlFor="sqb-first-name">First name</label>
                    <input
                      id="sqb-first-name"
                      name="firstName"
                      type="text"
                      autoComplete="given-name"
                      value={contact.firstName}
                      onChange={(e) => updateContact("firstName", e.target.value)}
                      maxLength={100}
                      required
                    />
                  </div>
                  <div className="sqb-field">
                    <label htmlFor="sqb-last-name">Last name</label>
                    <input
                      id="sqb-last-name"
                      name="lastName"
                      type="text"
                      autoComplete="family-name"
                      value={contact.lastName}
                      onChange={(e) => updateContact("lastName", e.target.value)}
                      maxLength={100}
                      required
                    />
                  </div>
                  <div className="sqb-field">
                    <label htmlFor="sqb-email">Email</label>
                    <input
                      id="sqb-email"
                      name="email"
                      type="email"
                      autoComplete="email"
                      inputMode="email"
                      value={contact.email}
                      onChange={(e) => updateContact("email", e.target.value)}
                      maxLength={254}
                      required
                    />
                  </div>
                  <div className="sqb-field">
                    <label htmlFor="sqb-phone">Phone</label>
                    <input
                      id="sqb-phone"
                      name="phone"
                      type="tel"
                      autoComplete="tel"
                      inputMode="tel"
                      placeholder="(555) 555-0100"
                      value={contact.phone}
                      onChange={(e) => updateContact("phone", e.target.value)}
                      maxLength={20}
                      required
                    />
                  </div>
                </fieldset>

                <p className="sqb-privacy-note">
                  Please do not include medical or sensitive health information. Chelsea will
                  discuss intake details with you directly.
                </p>

                {bookingError && <p className="sqb-message sqb-error" role="alert">{bookingError}</p>}
              </form>
            )}

            {step === "confirm" && bookingResult && (
              <div className="sqb-confirm">
                <span className="sqb-confirm-icon" aria-hidden="true">
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                    <path d="M22 4L12 14.01l-3-3" />
                  </svg>
                </span>
                <h3 className="sqb-confirm-title">Your test appointment is booked</h3>
                <dl className="sqb-confirm-list">
                  <div>
                    <dt>Service</dt>
                    <dd>{selectedService?.name}</dd>
                  </div>
                  <div>
                    <dt>Date &amp; time</dt>
                    <dd>
                      {formatDateLabel(date)} at {selectedSlot?.label}
                    </dd>
                  </div>
                  {bookingResult.bookingId && (
                    <div>
                      <dt>Booking reference</dt>
                      <dd>{bookingResult.bookingId}</dd>
                    </div>
                  )}
                </dl>
                <p className="sqb-confirm-note">
                  This is a Square Sandbox appointment for testing. No real booking was created and no
                  confirmation email was sent.
                </p>
                <div className="sqb-confirm-actions">
                  <button type="button" className="button ghost sqb-book-another" onClick={startOver}>
                    Book another test appointment
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        {step !== "confirm" && (
          <aside className="sqb-summary" aria-label="Appointment summary">
            <h4 className="sqb-summary-title">Your appointment</h4>

            {!selectedService ? (
              <p className="sqb-summary-empty">
                Choose a session to see your appointment details here.
              </p>
            ) : (
              <dl className="sqb-summary-list">
                {summaryRows.map((row) => (
                  <div key={row.key} className={row.value ? "" : " is-empty"}>
                    <dt>{row.label}</dt>
                    <dd>
                      {row.value || "\u2014"}
                      {row.sub && row.value ? <span className="sqb-summary-sub"> {row.sub}</span> : null}
                    </dd>
                  </div>
                ))}
                {contactName && (
                  <div>
                    <dt>Client</dt>
                    <dd>{contactName}</dd>
                  </div>
                )}
              </dl>
            )}

            <button
              type={step === "contact" ? "submit" : "button"}
              className="button primary sqb-primary"
              form={step === "contact" ? "sqb-form" : undefined}
              disabled={primaryDisabled}
              onClick={step === "contact" ? undefined : handlePrimary}
            >
              {primaryLabel}
            </button>
          </aside>
        )}
      </div>
    </div>
  );
}
