import { useMemo, useState } from "react";
import { bookingDates, bookingTimes, services } from "../data.js";

export default function Booking() {
  const [step, setStep] = useState(1);
  const [selectedService, setSelectedService] = useState(services[0]);
  const [selectedDate, setSelectedDate] = useState(bookingDates[0].date);
  const [selectedTime, setSelectedTime] = useState(bookingTimes[0]);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [notes, setNotes] = useState("");
  const [isSubmitted, setIsSubmitted] = useState(false);

  const summaryNote = useMemo(() => {
    if (!isSubmitted) return "No payment is collected today.";
    return name.trim()
      ? `Thanks, ${name.trim()}. Your request is ready for Chelsea to confirm.`
      : "Your request is ready for Chelsea to confirm.";
  }, [isSubmitted, name]);

  function moveTo(nextStep) {
    setStep(Math.min(Math.max(nextStep, 1), 3));
    window.requestAnimationFrame(() => {
      document.querySelector(".booking-card")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  function submitBooking(event) {
    event.preventDefault();
    setIsSubmitted(true);
  }

  return (
    <section className="booking-section" id="booking">
      <div className="section-heading" data-reveal>
        <p className="eyebrow">Book</p>
        <h2>Request your session.</h2>
        <p>Choose a service, preferred day, and time. Chelsea will confirm appointment details directly.</p>
      </div>

      <div className="booking-shell">
        <form className={`booking-card${isSubmitted ? " is-submitted" : ""}`} data-reveal onSubmit={submitBooking}>
          <div className="booking-progress" aria-label="Booking progress">
            {[1, 2, 3].map((progressStep) => (
              <span
                aria-current={progressStep === step ? "step" : undefined}
                className={progressStep <= step ? "active" : ""}
                key={progressStep}
              >
                {["Service", "Time", "Details"][progressStep - 1]}
              </span>
            ))}
          </div>

          {step === 1 && (
            <fieldset className="booking-step active">
              <legend>Choose your session</legend>
              {services.map((service) => (
                <label className="choice-card" key={service.id}>
                  <input
                    type="radio"
                    name="service"
                    checked={selectedService.id === service.id}
                    onChange={() => setSelectedService(service)}
                  />
                  <span>
                    <strong>{service.name}</strong>
                    <small>{service.duration} · {service.price}</small>
                  </span>
                  {selectedService.id === service.id && <em>Selected</em>}
                </label>
              ))}
              <button className="button primary next-button" type="button" onClick={() => moveTo(2)}>
                Continue
              </button>
            </fieldset>
          )}

          {step === 2 && (
            <fieldset className="booking-step active">
              <legend>Pick a day and time</legend>
              <div className="date-strip">
                {bookingDates.map(({ label, date }) => (
                  <button
                    className={`slot-button${selectedDate === date ? " active" : ""}`}
                    key={date}
                    type="button"
                    onClick={() => setSelectedDate(date)}
                  >
                    {label} {date}
                  </button>
                ))}
              </div>
              <div className="time-grid">
                {bookingTimes.map((time) => (
                  <button
                    className={`slot-button${selectedTime === time ? " active" : ""}`}
                    key={time}
                    type="button"
                    onClick={() => setSelectedTime(time)}
                  >
                    {time}
                  </button>
                ))}
              </div>
              <div className="step-actions">
                <button className="button ghost" type="button" onClick={() => moveTo(1)}>Back</button>
                <button className="button primary" type="button" onClick={() => moveTo(3)}>Continue</button>
              </div>
            </fieldset>
          )}

          {step === 3 && (
            <fieldset className="booking-step active">
              <legend>Your details</legend>
              <div className="form-grid">
                <label>
                  <span>Name</span>
                  <input value={name} onChange={(event) => setName(event.target.value)} type="text" autoComplete="name" placeholder="Your name" required />
                </label>
                <label>
                  <span>Phone</span>
                  <input value={phone} onChange={(event) => setPhone(event.target.value)} type="tel" autoComplete="tel" placeholder="(980) 224-2462" required />
                </label>
                <label className="full">
                  <span>Session notes</span>
                  <textarea value={notes} onChange={(event) => setNotes(event.target.value)} rows="4" placeholder="Focus areas, pressure preference, or anything Chelsea should know."></textarea>
                </label>
              </div>
              {isSubmitted && (
                <div className="confirmation-strip" role="status">
                  <span aria-hidden="true">✓</span>
                  <p>Your request is ready to confirm. The live booking calendar can connect here when it is time.</p>
                </div>
              )}
              <div className="step-actions">
                <button className="button ghost" type="button" onClick={() => moveTo(2)}>Back</button>
                <button className="button primary" type="submit">Request appointment</button>
              </div>
            </fieldset>
          )}
        </form>

        <aside className="booking-summary" aria-live="polite" data-reveal style={{ "--delay": "120ms" }}>
          <span className="panel-kicker">Appointment summary</span>
          <h3>{selectedService.name}</h3>
          <dl>
            <div>
              <dt>When</dt>
              <dd>{selectedDate} at {selectedTime}</dd>
            </div>
            <div>
              <dt>Location</dt>
              <dd>Downtown Mount Holly, NC</dd>
            </div>
            <div>
              <dt>Contact</dt>
              <dd>(980) 224-2462</dd>
            </div>
          </dl>
          <p>{summaryNote}</p>
        </aside>
      </div>
    </section>
  );
}
