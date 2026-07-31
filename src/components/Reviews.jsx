const REVIEWS = [
  { name: "Lisa L.", text: "Chelsea is great!" },
  { name: "Jessica B.", text: "I\u2019ve been going to Chelsea for a few years now, and she\u2019s always great!" },
  { name: "Anonymous", text: "Chelsea is amazing, you will love her." },
];

const REVIEWS_URL = "https://www.massagebook.com/therapists/kai-lani-bodywork-wellness/reviews?src=external";

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
        <a
          className="reviews-leave-link"
          href={REVIEWS_URL}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Leave a review \u2014 opens in a new tab"
        >
          Leave a review
          <span className="external-icon" aria-hidden="true"> &#8599;</span>
        </a>
      </div>
    </section>
  );
}
