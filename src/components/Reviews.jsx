import { useRef, useState, useEffect, useCallback } from "react";

const REVIEWS = [
  { name: "Lisa L.", text: "Chelsea is great!" },
  { name: "Jessica B.", text: "I\u2019ve been going to Chelsea for a few years now, and she\u2019s always great!" },
  { name: "Anonymous", text: "Chelsea is amazing, you will love her." },
];

const REVIEWS_URL = "https://www.massagebook.com/therapists/kai-lani-bodywork-wellness/reviews?src=external";

export default function Reviews() {
  const trackRef = useRef(null);
  const [index, setIndex] = useState(0);
  const maxIndex = REVIEWS.length - 1;
  const guardRef = useRef(false);

  const updateIndex = useCallback(() => {
    if (guardRef.current) return;
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
    guardRef.current = true;
    el.scrollLeft = Math.min(i * step, maxScroll);
    setIndex(i);
    setTimeout(() => { guardRef.current = false; }, 0);
  }

  return (
    <section className="reviews-section" id="reviews">
      <div className="section-heading" data-reveal>
        <p className="eyebrow">Reviews</p>
        <h2>What clients are saying.</h2>
      </div>

      <div className="reviews-summary" data-reveal>
        <div className="reviews-summary-main">
          <div className="reviews-rating-block">
            <span className="reviews-rating-number">5.0</span>
            <div className="reviews-rating-stars" role="img" aria-label="5 out of 5 stars">
              <span aria-hidden="true">★★★★★</span>
            </div>
          </div>
          <p className="reviews-count-text">Based on 22 verified MassageBook reviews.</p>
          <div className="reviews-badges">
            <span className="reviews-badge">Ambiance 99%</span>
            <span className="reviews-badge">Professionalism 100%</span>
          </div>
        </div>
        <a
          className="reviews-all-link"
          href={REVIEWS_URL}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Read all verified reviews on MassageBook \u2014 opens in a new tab"
        >
          Read all verified reviews on MassageBook
          <span className="external-icon" aria-hidden="true"> &#8599;</span>
        </a>
      </div>

      <div className="reviews-carousel-wrapper" data-reveal>
        <div className="reviews-carousel" ref={trackRef}>
          {REVIEWS.map((review, i) => (
            <div className="reviews-carousel-card" key={i}>
              <p className="reviews-card-text">{review.text}</p>
              <div className="reviews-card-meta">
                <span className="reviews-card-name">{review.name}</span>
                <span className="reviews-card-verified">Verified</span>
              </div>
            </div>
          ))}
        </div>

        <button
          className="reviews-carousel-arrow prev"
          aria-label="Previous review"
          disabled={index === 0}
          onClick={() => scrollTo(index - 1)}
        >
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <path d="M12 4L8 10L12 16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>
        <button
          className="reviews-carousel-arrow next"
          aria-label="Next review"
          disabled={index === maxIndex}
          onClick={() => scrollTo(index + 1)}
        >
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <path d="M8 4L12 10L8 16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>

        <div className="reviews-carousel-indicator" aria-live="polite">
          <span className="rci-current">{index + 1}</span>
          <span className="rci-sep">of</span>
          <span className="rci-total">{REVIEWS.length}</span>
        </div>
      </div>
    </section>
  );
}
