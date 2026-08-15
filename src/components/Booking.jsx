import { bookingRequestsEnabled } from "../lib/booking-flag.js";
import SquareBooking from "./calendar/SquareBooking.jsx";

const BOOKING_REQUESTS_ENABLED = bookingRequestsEnabled(import.meta.env);

export default function Booking() {
  return (
    <section className="booking-section" id="booking">
      {BOOKING_REQUESTS_ENABLED ? (
        <div data-reveal>
          <SquareBooking />
        </div>
      ) : (
        <>
          <div className="section-heading" data-reveal>
            <p className="eyebrow">Online booking</p>
            <h2>Booking is being finalized.</h2>
            <p>
              Chelsea's new online booking experience is almost ready. For an appointment,
              call or email Kai Lani directly.
            </p>
          </div>

          <div className="booking-after" data-reveal style={{ "--delay": "120ms" }}>
            <div className="booking-contact-card">
              <div className="booking-contact-actions">
                <a className="button sand compact" href="tel:+19802242462">
                  Call (980) 224-2462
                </a>
                <a
                  className="booking-email-link"
                  href="mailto:kailanibodywork@gmail.com?subject=Appointment%20request"
                >
                  Email Kai Lani
                </a>
              </div>
              <p className="booking-footnote">Online scheduling will be available here soon.</p>
            </div>
          </div>
        </>
      )}
    </section>
  );
}