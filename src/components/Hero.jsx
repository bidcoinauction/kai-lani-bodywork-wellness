export default function Hero() {
  return (
    <section className="hero">
      <div className="hero-content">
        <p className="eyebrow hero-kicker">Opening May 1, 2026 · Downtown Mount Holly</p>
        <h1>Kai Lani Bodywork & Wellness</h1>
        <p className="hero-copy">
          Therapeutic massage and restorative bodywork by Chelsea Askew, NC LMBT license no. 19862.
        </p>
        <div className="hero-actions">
          <a className="button primary" href="#booking">Book a session</a>
          <a className="button secondary" href="tel:+19802242462">(980) 224-2462</a>
        </div>
      </div>
      <div className="hero-panel" aria-label="Appointment preview">
        <span className="panel-kicker">Now booking</span>
        <strong>Soft opening appointments begin May 1</strong>
        <p>Choose a service, preferred day, and time. The calendar connection can be added when the live booking link is ready.</p>
      </div>
    </section>
  );
}
