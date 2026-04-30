import { experienceHighlights } from "../data.js";

export default function Experience() {
  return (
    <section className="experience-section" id="experience">
      <div className="experience-copy" data-reveal>
        <p className="eyebrow">Your visit</p>
        <h2>A quiet, intentional studio experience in Downtown Mount Holly.</h2>
        <p>
          Each appointment starts with a brief conversation, then Chelsea tailors pressure, pacing, and focus areas to your goals for the day.
        </p>
      </div>
      <div className="experience-list" aria-label="Studio experience highlights">
        {experienceHighlights.map((highlight, index) => (
          <div data-reveal key={highlight} style={{ "--delay": `${index * 70}ms` }}>
            <span></span>
            <p>{highlight}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
