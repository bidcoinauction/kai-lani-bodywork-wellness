import { services } from "../data.js";

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
          </article>
        ))}
      </div>
    </section>
  );
}
