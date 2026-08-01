const REVIEWS = [
  { name: "Lisa L.", text: "Chelsea is great!" },
  { name: "Jessica B.", text: "I've been going to Chelsea for a few years now, and she's always great!" },
  { name: "Anonymous", text: "Chelsea is amazing, you will love her." },
];

export default function Reviews() {
  return (
    <section className="reviews-section" id="reviews">
      <div className="section-heading" data-reveal>
        <p className="eyebrow">Reviews</p>
        <h2>What clients are saying.</h2>
      </div>

      <div className="reviews-grid" data-reveal>
        {REVIEWS.map((review, i) => (
          <div className="reviews-card" key={i} data-reveal style={{ "--delay": `${i * 90}ms` }}>
            <p className="reviews-card-text">{review.text}</p>
            <p className="reviews-card-name">{review.name}</p>
          </div>
        ))}
      </div>

      <div className="reviews-footer" data-reveal>
        <span>5.0 average rating</span>
        <span>Based on 22 client reviews</span>
        <span>Ambiance 99%</span>
        <span>Professionalism 100%</span>
      </div>
    </section>
  );
}
