import { addOns, services } from "../data.js";

export default function Services() {
  return (
    <section className="services-section" id="services">
      <div className="section-heading" data-reveal>
        <p className="eyebrow">Services</p>
        <h2>Bodywork with a clear path from check-in to reset.</h2>
      </div>
      <div className="service-grid">
        {services.map((service, index) => (
          <article
            className="service-card"
            data-reveal
            key={service.id}
            style={{ "--delay": `${index * 90}ms` }}
          >
            <div className="service-topline">
              <span>{service.number}</span>
              <strong>{service.duration}</strong>
            </div>
            <h3>{service.name}</h3>
            <p>{service.description}</p>
            <span className="price">{service.price}</span>
          </article>
        ))}
      </div>
      <div className="addon-heading" data-reveal>
        <p className="eyebrow">Add-ons</p>
        <h3>Enhance your session with an extra touch.</h3>
      </div>
      <div className="addons-panel" data-reveal style={{ "--delay": "60ms" }}>
        {addOns.map((addOn) => (
          <div className="addon-row" key={addOn.id}>
            <div className="addon-info">
              <span className="addon-name">{addOn.name}</span>
              {addOn.duration && (
                <span className="addon-duration">· {addOn.duration}</span>
              )}
            </div>
            <span className="addon-price">{addOn.price}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
