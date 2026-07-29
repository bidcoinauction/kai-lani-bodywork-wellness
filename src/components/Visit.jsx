const mapsEmbedUrl = "https://www.google.com/maps?q=106+S+Main+St+Suite+F,+Mount+Holly,+NC+28120&z=19&output=embed";
const mapsDirectionsUrl = "https://www.google.com/maps/dir/?api=1&destination=106+S+Main+St+Suite+F,+Mount+Holly,+NC+28120";

export default function Visit() {
  return (
    <section className="visit-section" id="visit">
      <div data-reveal>
        <p className="eyebrow">Visit</p>
        <h2>Downtown Mount Holly Historic District</h2>
        <p>Visit us through the private rear entrance at 106 S Main Street in Downtown Mount Holly.</p>
      </div>
      <div className="visit-card" data-reveal style={{ "--delay": "120ms" }}>
        <div className="visit-card-info">
          <p className="visit-card-heading">106 S Main St, Suite F</p>
          <p className="visit-card-sub">Mount Holly, NC 28120</p>
          <p className="visit-card-note">Google Maps will bring you to the building, but Suite F has its own exterior entrance around back. From South Main Street, turn into the narrow drive beside Uptown Salon and follow it behind the building. Do not enter through the storefronts on Main Street. Look for the black metal staircase at the rear of the building. The separate Suite F entrance is on the ground level immediately beyond the staircase. Do not go up the stairs.</p>
          <div className="visit-card-actions">
            <a className="button visit-card-directions" href={mapsDirectionsUrl} target="_blank" rel="noopener noreferrer">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
              Get Directions
            </a>
            <a className="visit-card-social" href="https://www.instagram.com/kailani.bdywrk/" target="_blank" rel="noopener noreferrer">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="2" y="2" width="20" height="20" rx="5" ry="5"/><path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z"/><line x1="17.5" y1="6.5" x2="17.51" y2="6.5"/></svg>
              Follow @kailani.bdywrk
            </a>
          </div>
        </div>
        <div className="visit-card-map">
          <iframe
            src={mapsEmbedUrl}
            title="Map of 106 S Main St, Suite F, Mount Holly, NC"
            loading="lazy"
            allowFullScreen
          />
        </div>
      </div>
    </section>
  );
}
