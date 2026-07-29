import { MASSAGEBOOK_URL, reviewsData } from "../data.js";

export default function Reviews() {
  return (
    <section className="reviews-section" id="reviews">
      <div className="section-heading" data-reveal>
        <p className="eyebrow">Reviews</p>
        <h2>What clients are saying.</h2>
        <div className="reviews-rating">
          <span className="reviews-stars">
            <span aria-hidden="true">★</span> {reviewsData.averageRating}
          </span>
          <p>Based on {reviewsData.totalReviews} verified MassageBook reviews.</p>
        </div>
        <div className="reviews-stats">
          <span className="reviews-stat">Ambiance: {reviewsData.ambiance}</span>
          <span className="reviews-stat">Professionalism: {reviewsData.professionalism}</span>
        </div>
      </div>
      <div className="reviews-grid" data-reveal>
        {reviewsData.items.map((review, index) => (
          <div className="review-card" key={index}>
            <p className="review-text">&ldquo;{review.text}&rdquo;</p>
            <div className="review-footer">
              <span className="review-name">{review.name}</span>
              <span className="review-verified">Verified MassageBook review</span>
            </div>
          </div>
        ))}
      </div>
      <a
        className="button primary reviews-link"
        href={MASSAGEBOOK_URL}
        target="_blank"
        rel="noopener noreferrer"
      >
        Read all reviews on MassageBook
      </a>
    </section>
  );
}
