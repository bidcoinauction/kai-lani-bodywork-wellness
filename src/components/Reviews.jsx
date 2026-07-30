export default function Reviews() {
  return (
    <section className="reviews-section" id="reviews">
      <div className="section-heading" data-reveal>
        <p className="eyebrow">Reviews</p>
        <h2>What clients are saying.</h2>
        <div className="reviews-rating">
          <span className="reviews-stars">
            <span aria-hidden="true">★</span> 5.0
          </span>
          <p>Based on 22 verified MassageBook reviews.</p>
        </div>
        <div className="reviews-stats">
          <span className="reviews-stat">Ambiance: 99%</span>
          <span className="reviews-stat">Professionalism: 100%</span>
        </div>
      </div>
      <div className="massagebook-frame-container">
        <iframe
          src="https://www.massagebook.com/therapists/kai-lani-bodywork-wellness/widget/reviews"
          title="Verified reviews for Kai Lani Bodywork & Wellness"
          className="massagebook-reviews-frame"
          loading="lazy"
          referrerPolicy="strict-origin-when-cross-origin"
        />
      </div>
    </section>
  );
}
