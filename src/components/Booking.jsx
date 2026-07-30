import { useState } from "react";
import { bookingServices, GIFT_CERT_URL } from "../data.js";

export default function Booking() {
  const [selectedService, setSelectedService] = useState(null);

  return (
    <section className="booking-section" id="booking">
      <div className="section-heading" data-reveal>
        <p className="eyebrow">Book</p>
        <h2>Choose your service.</h2>
        <p>Select a session type, then check availability and book securely through MassageBook.</p>
      </div>

      <div className="booking-shell">
        <div className="booking-card" data-reveal>
          <div className="booking-service-grid">
            {bookingServices.map((service) => {
              const isSelected = selectedService?.id === service.id;
              return (
                <button
                  className={`booking-service-card${isSelected ? " selected" : ""}`}
                  key={service.id}
                  type="button"
                  aria-pressed={isSelected}
                  onClick={() => setSelectedService(service)}
                >
                  <div className="booking-service-topline">
                    <span>{service.number}</span>
                    <strong>{service.duration}</strong>
                  </div>
                  <h3>{service.name}</h3>
                  <p className="booking-service-desc">{service.description}</p>
                  <div className="booking-service-bottom">
                    {isSelected && (
                      <span className="selected-label">Selected &#10003;</span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

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
                <dt>Service</dt>
                <dd>{selectedService.name}</dd>
                <dd className="summary-detail">{selectedService.duration} — {selectedService.price}</dd>
              </div>
            )}
            <div>
              <dt>Total</dt>
              <dd>{selectedService ? selectedService.price : "$0"}</dd>
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

          <div className="booking-action">
            {selectedService ? (
              <a
                className="button primary booking-cta"
                href={selectedService.bookingUrl}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`Check MassageBook availability for ${selectedService.name} — opens in a new tab`}
              >
                Check Availability &amp; Book
                <span className="external-icon" aria-hidden="true"> &#8599;</span>
              </a>
            ) : (
              <button className="button primary booking-cta" type="button" disabled>
                Choose a session to continue
              </button>
            )}
            <p className="booking-support-text">You&rsquo;ll choose your time and complete scheduling securely through MassageBook. Your appointment is confirmed only after you finish the MassageBook booking process.</p>
            <p className="enhancements-note">Available enhancements can be selected during MassageBook checkout.</p>
            <a
              className="gift-cert-link"
              href={GIFT_CERT_URL}
              target="_blank"
              rel="noopener noreferrer"
            >
              Gift certificates
            </a>
          </div>
        </aside>
      </div>
    </section>
  );
}
