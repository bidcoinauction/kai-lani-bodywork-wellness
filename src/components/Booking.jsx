import { useMemo, useState } from "react";
import { addOns, bookingTimes, services } from "../data.js";

export default function Booking() {
  const [step, setStep] = useState(1);
  const [selectedService, setSelectedService] = useState(null);
  const [selectedTime, setSelectedTime] = useState(null);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [notes, setNotes] = useState("");
  const [selectedAddOns, setSelectedAddOns] = useState([]);
  const [isSubmitted, setIsSubmitted] = useState(false);

  function toggleAddOn(addOnId) {
    setSelectedAddOns((prev) =>
      prev.includes(addOnId) ? prev.filter((id) => id !== addOnId) : [...prev, addOnId]
    );
  }

  const totalPrice = useMemo(() => {
    if (!selectedService) return "$0";
    const base = parseInt(selectedService.price.replace("$", ""));
    const extras = selectedAddOns.reduce((sum, id) => {
      const addOn = addOns.find((a) => a.id === id);
      return sum + parseInt(addOn.price.replace("$", ""));
    }, 0);
    return `$${base + extras}`;
  }, [selectedService, selectedAddOns]);

  const summaryNote = useMemo(() => {
    if (!isSubmitted) return "No payment is collected today.";
    const addOnText = selectedAddOns.length > 0
      ? ` with ${selectedAddOns.map((id) => addOns.find((a) => a.id === id).name.toLowerCase()).join(" & ")}`
      : "";
    return name.trim()
      ? `Thanks, ${name.trim()}${addOnText}. Your request is ready for Chelsea to confirm.`
      : `Your request${addOnText} is ready for Chelsea to confirm.`;
  }, [isSubmitted, name, selectedAddOns]);

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
              <div className="booking-service-grid">
                {services.map((service) => (
                  <button
                    className={`booking-service-card${selectedService?.id === service.id ? " selected" : ""}`}
                    key={service.id}
                    type="button"
                    onClick={() => setSelectedService(service)}
                  >
                    <div className="booking-service-topline">
                      <span>{service.number}</span>
                      <strong>{service.duration}</strong>
                    </div>
                    <h3>{service.name}</h3>
                    <div className="booking-service-bottom">
                      {selectedService?.id === service.id && (
                        <span className="selected-label">Selected ✓</span>
                      )}
                    </div>
                  </button>
                ))}
              </div>
              <p className="addons-label">Enhance your session</p>
              <div className="booking-addon-grid">
                {addOns.map((addOn) => {
                  const isAdded = selectedAddOns.includes(addOn.id);
                  return (
                    <button
                      className={`booking-addon-card${isAdded ? " selected" : ""}`}
                      key={addOn.id}
                      type="button"
                      onClick={() => toggleAddOn(addOn.id)}
                    >
                      <div className="booking-addon-info">
                        <span className="booking-addon-name">{addOn.name}</span>
                        {addOn.duration && (
                          <span className="booking-addon-duration">· {addOn.duration}</span>
                        )}
                      </div>
                      <span className={`booking-addon-status${isAdded ? " added" : ""}`}>
                        {isAdded ? "✓ Added" : "+ Add"}
                      </span>
                    </button>
                  );
                })}
              </div>
              <div className="step-footer">
                {selectedService && <span className="step-total">Total {totalPrice}</span>}
                <button
                  className="button primary next-button"
                  type="button"
                  onClick={() => moveTo(2)}
                  disabled={!selectedService}
                >
                  Continue
                </button>
              </div>
            </fieldset>
          )}

          {step === 2 && (
            <fieldset className="booking-step active">
              <legend>Pick a time preference</legend>
              <p className="addons-label" style={{ marginBottom: 14 }}>Chelsea will confirm a date that works for you.</p>
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
                <button
                  className="button primary"
                  type="button"
                  onClick={() => moveTo(3)}
                  disabled={!selectedTime}
                >
                  Continue
                </button>
              </div>
            </fieldset>
          )}

          {step === 3 && (
            <fieldset className="booking-step active">
              <legend>Confirm and book</legend>
              <div className="selection-review">
                <div className="selection-review-row">
                  <div className="selection-review-info">
                    <strong>{selectedService.name}</strong>
                    <span>{selectedService.duration}</span>
                  </div>
                  <span className="selection-review-price">{selectedService.price}</span>
                </div>
                {selectedAddOns.map((id) => {
                  const addOn = addOns.find((a) => a.id === id);
                  return (
                    <div className="selection-review-row" key={id}>
                      <div className="selection-review-info">
                        <span>{addOn.name}</span>
                        {addOn.duration && <span className="review-addon-duration">{addOn.duration}</span>}
                      </div>
                      <span className="selection-review-price">{addOn.price}</span>
                    </div>
                  );
                })}
                <div className="selection-review-total">
                  <span>Total</span>
                  <span>{totalPrice}</span>
                </div>
              </div>
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
          {selectedService ? (
            <h3>{selectedService.name}</h3>
          ) : (
            <p className="summary-muted">No service selected yet.</p>
          )}
          <dl>
            {selectedService && (
              <div>
                <dt>Duration</dt>
                <dd>{selectedService.duration}</dd>
              </div>
            )}
            <div>
              <dt>Time preference</dt>
              <dd>{selectedTime || "Not selected yet"}</dd>
            </div>
            {selectedAddOns.length > 0 && (
              <div>
                <dt>Add-ons</dt>
                <dd>{selectedAddOns.map((id) => addOns.find((a) => a.id === id).name).join(", ")}</dd>
              </div>
            )}
            <div>
              <dt>Total</dt>
              <dd>{totalPrice}</dd>
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
