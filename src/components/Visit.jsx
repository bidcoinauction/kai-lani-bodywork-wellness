const address = "106 S Main St, Suite F, Mount Holly, NC 28120";
const encodedAddress = encodeURIComponent(address);
const mapsUrl = `https://www.google.com/maps/dir/?api=1&destination=${encodedAddress}`;
const osmEmbedUrl = `https://www.openstreetmap.org/export/embed.html?bbox=-81.0209,35.2895,-81.0109,35.2975&layer=mapnik&marker=35.2935,-81.0159`;

export default function Visit() {
  return (
    <section className="visit-section" id="visit">
      <div data-reveal>
        <p className="eyebrow">Visit</p>
        <h2>Downtown Mount Holly Historic District</h2>
        <p>Located in the former Oak Essentials Wellness suite. Full address and parking details can be added before launch.</p>
      </div>
      <div className="contact-card" data-reveal style={{ "--delay": "120ms" }}>
        <span>Appointments</span>
        <a href="tel:+19802242462">(980) 224-2462</a>
        <small>No DMs for appointments, please.</small>
        <span style={{ marginTop: 14 }}>Follow</span>
        <a href="https://www.instagram.com/kailani.bdywrk/" target="_blank" rel="noopener noreferrer" style={{ display: "inline-flex", alignItems: "center", gap: 6, marginTop: 4 }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="2" y="2" width="20" height="20" rx="5" ry="5"/><path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z"/><line x1="17.5" y1="6.5" x2="17.51" y2="6.5"/></svg>
          @kailani.bdywrk
        </a>
      </div>
      <div className="map-block" data-reveal style={{ "--delay": "240ms" }}>
        <div className="map-block-address">
          <span className="map-block-label">Address</span>
          <strong>106 S Main St, Suite F</strong>
          <span>Mount Holly, NC 28120</span>
        </div>
        <div className="map-block-frame">
          <iframe
            src={osmEmbedUrl}
            title="Map of 106 S Main St, Mount Holly, NC"
            loading="lazy"
            allowFullScreen
          />
        </div>
        <div className="map-block-note">
          <p>Suite F is located behind the salon. Please go around to the rear of the building and look for the Suite F entrance.</p>
        </div>
        <a className="button secondary map-block-directions" href={mapsUrl} target="_blank" rel="noopener noreferrer">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
          Get Directions
        </a>
      </div>
    </section>
  );
}
