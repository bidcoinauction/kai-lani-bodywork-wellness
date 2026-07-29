import { useMemo, useState } from "react";
import { addOns, MASSAGEBOOK_URL, services } from "../data.js";

export default function Booking() {
  const [selectedService, setSelectedService] = useState(null);
  const [selectedAddOns, setSelectedAddOns] = useState([]);

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

  return (
    <section className="booking-section" id="booking">
      <div className="section-heading" data-reveal>
        <p className="eyebrow">Book</p>
        <h2>Plan your session.</h2>
        <p>Choose a service and enhancements, then complete your booking below.</p>
      </div>

      <div className="booking-shell">
        <div className="booking-card" data-reveal>
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
          {/* data-mount="massagebook-widget" is the replacement boundary for the official MassageBook embed snippet */}
          {selectedService && (
            <div className="booking-integration" data-mount="massagebook-widget">
              <p className="integration-total">Total {totalPrice}</p>
              <div className="integration-preview">
                <span className="integration-badge">MassageBook booking preview</span>
                <h3 className="integration-heading">Complete your booking</h3>
                <p className="integration-copy">Once connected, clients will be able to view live availability and complete their booking here without leaving the Kai Lani website.</p>
                <a
                  className="button primary integration-fallback"
                  href={MASSAGEBOOK_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  View Kai Lani on MassageBook
                </a>
              </div>
            </div>
          )}
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
              <dt>Add-ons</dt>
              {selectedAddOns.length > 0 ? (
                <dd>
                  <ul className="summary-addon-list">
                    {selectedAddOns.map((id) => {
                      const addOn = addOns.find((a) => a.id === id);
                      return (
                        <li key={id}>
                          <span>{addOn.name}</span>
                          <span className="summary-detail">{addOn.price}</span>
                        </li>
                      );
                    })}
                  </ul>
                </dd>
              ) : (
                <dd className="summary-detail">None</dd>
              )}
            </div>
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
        </aside>
      </div>
    </section>
  );
}
