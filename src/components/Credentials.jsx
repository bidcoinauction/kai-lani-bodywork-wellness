import { credentialCards } from "../data.js";

export default function Credentials() {
  return (
    <section className="credentials-section" aria-label="License verification">
      <div className="credentials-heading" data-reveal>
        <p className="eyebrow">Verified care</p>
        <h2>Licensed in North Carolina.</h2>
      </div>
      <div className="credential-grid">
        {credentialCards.map((card, index) => (
          <a
            className="credential-card"
            data-reveal
            href={card.href}
            key={card.id}
            style={{ "--delay": `${index * 80}ms` }}
          >
            <span className="credential-mark" aria-hidden={card.image ? undefined : "true"}>
              {card.image ? <img src={card.image} alt={card.imageAlt} /> : card.monogram}
            </span>
            <span className="credential-copy">
              <small>{card.eyebrow}</small>
              <strong>{card.title}</strong>
              <em>{card.detail}</em>
            </span>
          </a>
        ))}
      </div>
    </section>
  );
}
