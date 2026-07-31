import { useRef, useState, useEffect, useCallback } from "react";
import { bookingServices, GIFT_CERT_URL } from "../data.js";
import SquareBooking from "./calendar/SquareBooking.jsx";

const SQUARE_SANDBOX_ENABLED = import.meta.env.VITE_ENABLE_SQUARE_SANDBOX === "true";

export default function Booking() {
  const trackRef = useRef(null);
  const [index, setIndex] = useState(0);
  const maxIndex = bookingServices.length - 1;
  const scrollGuardRef = useRef(false);

  const updateIndex = useCallback(() => {
    if (scrollGuardRef.current) return;
    const el = trackRef.current;
    if (!el) return;
    const { children } = el;
    const containerLeft = el.getBoundingClientRect().left;
    let closest = 0;
    let minDist = Infinity;
    for (let i = 0; i < children.length; i++) {
      const rect = children[i].getBoundingClientRect();
      const dist = Math.abs(rect.left - containerLeft);
      if (dist < minDist) {
        minDist = dist;
        closest = i;
      }
    }
    setIndex(Math.min(closest, maxIndex));
  }, [maxIndex]);

  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    el.addEventListener("scroll", updateIndex, { passive: true });
    updateIndex();
    return () => el.removeEventListener("scroll", updateIndex);
  }, [updateIndex]);

  function scrollTo(i) {
    const el = trackRef.current;
    if (!el) return;
    const card = el.children[0];
    if (!card) return;
    const cardWidth = card.getBoundingClientRect().width;
    const step = cardWidth + 12;
    const maxScroll = el.scrollWidth - el.clientWidth;
    scrollGuardRef.current = true;
    el.scrollLeft = Math.min(i * step, maxScroll);
    setIndex(i);
    setTimeout(() => { scrollGuardRef.current = false; }, 0);
  }

  return (
    <section className="booking-section" id="booking">
      {SQUARE_SANDBOX_ENABLED ? (
        <div data-reveal>
          <SquareBooking />
        </div>
      ) : (
        <>
          <div className="section-heading" data-reveal>
            <p className="eyebrow">Online booking</p>
            <h2>Choose your session.</h2>
            <p>
              Select a service to view Chelsea&rsquo;s live availability and complete your appointment
              securely through MassageBook.
            </p>
          </div>

          <div className="booking-carousel-wrapper" data-reveal>
            <div className="booking-carousel" ref={trackRef}>
              {bookingServices.map((service, i) => (
                <div className="booking-carousel-card" key={service.id}>
                  <div className="bcc-topline">
                    <span className="bcc-number">{service.number}</span>
                    <span className="bcc-duration">{service.duration}</span>
                  </div>
                  <h3 className="bcc-name">{service.name}</h3>
                  <p className="bcc-desc">{service.description}</p>
                  <a
                    className="button sand compact bcc-link"
                    href={service.bookingUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={`Book ${service.name} on MassageBook — opens in a new tab`}
                  >
                    Book on MassageBook
                    <span className="external-icon" aria-hidden="true"> &#8599;</span>
                  </a>
                </div>
              ))}
            </div>

            <button
              className="booking-carousel-arrow prev"
              aria-label="Previous service"
              disabled={index === 0}
              onClick={() => scrollTo(index - 1)}
            >
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                <path d="M12 4L8 10L12 16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>
            <button
              className="booking-carousel-arrow next"
              aria-label="Next service"
              disabled={index === maxIndex}
              onClick={() => scrollTo(index + 1)}
            >
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                <path d="M8 4L12 10L8 16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>

            <div className="booking-carousel-indicator" aria-live="polite">
              <span className="bci-current">{index + 1}</span>
              <span className="bci-sep">of</span>
              <span className="bci-total">{bookingServices.length}</span>
            </div>
          </div>

          <div className="booking-after" data-reveal style={{ "--delay": "120ms" }}>
            <p className="booking-footnote">MassageBook handles availability, appointment confirmation, intake, and payment settings.</p>
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
        </>
      )}
    </section>
  );
}
