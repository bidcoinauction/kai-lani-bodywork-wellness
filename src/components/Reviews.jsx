const REVIEWS = [
  { name: "Jessica B.", text: "I've been going to Chelsea for a few years now, and she's always great!" },
  { name: "Danielle H.", text: "Chelsea is great at listening to where your problem areas are and focusing on them, helping you get back to feeling much better. I definitely recommend her and can't wait until my next appointment!" },
  { name: "Kristina C.", text: "I've had quite a few massages before, but nothing compares to the experience I had with Chelsea. She took the time to ask how my body had been feeling and where I was holding tension." },
];

const GOOGLE_REVIEWS_URL = "https://share.google/6BsWblbbdtHP9RrsI";

const ANONYMOUS_NAME_PATTERN = /\b(anonymous|unnamed|guest)\b/i;

function isDisplayableReview(review) {
  if (!review || typeof review !== "object") return false;
  const name = typeof review.name === "string" ? review.name.trim() : "";
  const text = typeof review.text === "string" ? review.text.trim() : "";
  if (!name || !text) return false;
  if (ANONYMOUS_NAME_PATTERN.test(name)) return false;
  if (!/[a-zA-Z]{2,}/.test(name)) return false;
  return true;
}

const VISIBLE_REVIEWS = REVIEWS.filter(isDisplayableReview);

export default function Reviews() {
  const hasTwoCards = VISIBLE_REVIEWS.length === 2;

  return (
    <section className="reviews-section" id="reviews">
      <div className="section-heading" data-reveal>
        <p className="eyebrow">Reviews</p>
        <h2>What clients are saying.</h2>
      </div>

      <div className={hasTwoCards ? "reviews-grid reviews-grid--two" : "reviews-grid"} data-reveal>
        {VISIBLE_REVIEWS.map((review, i) => (
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

      <div className="reviews-google-wrap" data-reveal>
        <a
          className="button reviews-google-link"
          href={GOOGLE_REVIEWS_URL}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Read and leave a review on Google — opens in a new tab"
        >
          Read and leave a review on Google
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <line x1="7" y1="17" x2="17" y2="7" />
            <polyline points="7 7 17 7 17 17" />
          </svg>
        </a>
      </div>
    </section>
  );
}
