# Local SEO Google Profile

Use this as the source of truth when preparing Google Business Profile and
webmaster setup. Do not add keywords to the business name unless the real-world
business name changes.

## Business Identity

- Business name: Kai Lani Bodywork & Wellness
- Website: https://www.kailanibodywork.com/
- Phone: (980) 224-2462
- Email: appointments@kailanibodywork.com
- Address: 106 S Main St, Suite F, Mount Holly, NC 28120
- Public Instagram: https://www.instagram.com/kailani.bdywrk/
- Provider: Chelsea Teller, Licensed Massage Therapist, NC LMBT license no. 19862

## Google Business Profile Categories

- Primary category: Massage therapist
- Secondary categories: use only if Google Business Profile offers an exact,
  real match for services currently provided. Avoid broad or unrelated wellness
  categories.

Google's public Business Profile material confirms that service businesses can
show service areas, specialties, services, reviews, photos, and booking details.
The final category must be selected from the live Google Business Profile UI.

## Business Description Draft

Kai Lani Bodywork & Wellness provides personalized massage therapy in Downtown
Mount Holly, North Carolina. Licensed massage therapist Chelsea Teller offers
customized massage, customized deep tissue massage, and prenatal massage in a
calm studio at 106 S Main St, Suite F. Sessions are tailored to each client's
goals, pressure preferences, and focus areas.

## Services

- Customized Massage: Personalized massage therapy tailored to the client's
  goals, pressure preferences, and focus areas. Available in 60- and 90-minute
  sessions.
- Customized Deep Tissue Massage: Focused bodywork for clients who prefer more
  targeted pressure and slower work on persistent tension areas. Available in
  60- and 90-minute sessions where offered.
- Prenatal Massage: Comfort-focused prenatal massage for relaxation and support
  during pregnancy. Available as a 60-minute session.

Avoid medical promises, guaranteed outcomes, urgency claims, or ranking claims.

## Photos Checklist

- Exterior/building from South Main Street.
- Rear entrance approach.
- Suite F entrance.
- Treatment space.
- Chelsea professional portrait.
- Business logo.
- Clean interior/detail photos.
- Bolton's Curbside Cookery as a nearby arrival landmark; do not label 108 S
  Main St as Kai Lani's address.

Photos of the rear entrance are especially important because Suite F has a
separate rear exterior entrance and the Main Street storefronts can be confusing.
Use Bolton's Curbside Cookery only as a visual landmark for arrival directions.

## Review Strategy

After completed appointments, politely invite clients to leave an honest Google
review. Do not offer compensation, require positive reviews, gate negative
customers away from Google, or write reviews for clients.

Suggested request:

```text
Thank you for visiting Kai Lani. If you feel comfortable sharing your experience,
an honest Google review helps local clients understand what to expect. No
pressure, and all feedback is welcome.
```

Google notes that review count and review score can contribute to local
prominence, so the process should be steady, ethical, and compliant.

## Search Console Setup

Preferred setup after deployment:

1. Add `https://www.kailanibodywork.com/` as a URL-prefix property, or use a
   domain property if DNS access is available.
2. Verify ownership using the method available to the site owner.
3. Inspect `https://www.kailanibodywork.com/`.
4. Submit `https://www.kailanibodywork.com/sitemap.xml`.
5. Request homepage indexing.
6. Monitor Page Indexing.
7. Monitor Search Performance.
8. Monitor Core Web Vitals.
9. Monitor structured data enhancements and validation messages.

Do not claim verification is complete until someone with access completes it in
Google Search Console.

## Bing Webmaster Tools Setup

1. Create or sign into Bing Webmaster Tools.
2. Add `https://www.kailanibodywork.com/`.
3. Import from Google Search Console if available, or verify directly.
4. Submit `https://www.kailanibodywork.com/sitemap.xml`.
5. Monitor indexing and crawl issues.

## Service Page Architecture

Recommended future URLs, only when each page has genuinely useful content:

- `/massage-therapy-mount-holly/`
- `/deep-tissue-massage-mount-holly/`
- `/prenatal-massage-mount-holly/`

Do not create thin doorway pages. Each page should explain the service, session
options, Chelsea's approach, what clients can expect, the Downtown Mount Holly
location, and a booking CTA. Keep medical claims out of the copy.

This pass keeps the stable single-page architecture and strengthens homepage
entity signals instead of adding new SPA routes before the booking workflow has
more normal Production traffic.

## Performance Watchlist

- Google Fonts: keep preconnects and `display=swap`; consider self-hosting only
  if Core Web Vitals show font-related delays.
- Images: keep social/logo assets modest; compress future photography before
  upload.
- Map iframe: keep lazy-loaded and do not rely on it for primary NAP text.
- JavaScript: avoid adding route/content frameworks solely for SEO until there
  is evidence the SPA is limiting indexing.
- Layout shift: keep hero dimensions and visible business text stable on mobile.

Use PageSpeed Insights or Search Console Core Web Vitals after deployment for
field data. Do not fabricate passing field data without access.
