import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CANONICAL_URL = "https://www.kailanibodywork.com/";
const OLD_DOMAIN = new RegExp(["kailani", "wellness"].join("") + "\\.com", "i");

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

function metadataJsonLd() {
  const html = read("index.html");
  const match = html.match(/<script type="application\/ld\+json">\s*([\s\S]*?)\s*<\/script>/);
  assert.ok(match, "index.html must contain JSON-LD");
  return JSON.parse(match[1]);
}

test("homepage canonical and social metadata use the canonical production host", () => {
  const html = read("index.html");

  assert.match(html, /<title>Massage Therapy in Mount Holly, NC \| Kai Lani Bodywork & Wellness<\/title>/);
  assert.match(html, /Personalized massage therapy in Downtown Mount Holly, NC with licensed massage therapist Chelsea Teller/);
  assert.match(html, new RegExp(`<link rel="canonical" href="${CANONICAL_URL}" />`));
  assert.match(html, /<meta property="og:url" content="https:\/\/www\.kailanibodywork\.com\/" \/>/);
  assert.match(html, /<meta property="og:image" content="https:\/\/www\.kailanibodywork\.com\/kai-lani-logo\.jpg" \/>/);
  assert.match(html, /<meta name="twitter:image" content="https:\/\/www\.kailanibodywork\.com\/kai-lani-logo\.jpg" \/>/);
  assert.doesNotMatch(html, OLD_DOMAIN);
});

test("JSON-LD parses and defines the local business identity", () => {
  const data = metadataJsonLd();
  assert.equal(data["@context"], "https://schema.org");
  assert.ok(Array.isArray(data["@graph"]));

  const website = data["@graph"].find((node) => node["@type"] === "WebSite");
  const business = data["@graph"].find((node) => node["@type"] === "HealthAndBeautyBusiness");
  const person = data["@graph"].find((node) => node["@type"] === "Person");

  assert.equal(website.url, CANONICAL_URL);
  assert.equal(website.name, "Kai Lani Bodywork & Wellness");
  assert.equal(business.name, "Kai Lani Bodywork & Wellness");
  assert.equal(business.url, CANONICAL_URL);
  assert.equal(business.telephone, "+19802242462");
  assert.equal(business.email, "kailanibodywork@gmail.com");
  assert.deepEqual(business.sameAs, ["https://www.instagram.com/kailani.bdywrk/"]);
  assert.equal(business.address.streetAddress, "106 S Main St, Suite F");
  assert.equal(business.address.addressLocality, "Mount Holly");
  assert.equal(business.address.addressRegion, "NC");
  assert.equal(business.address.postalCode, "28120");
  assert.equal(person.name, "Chelsea Teller");
  assert.equal(person.jobTitle, "Licensed Massage Therapist");
});

test("robots.txt allows crawling and identifies the canonical sitemap", () => {
  const robots = read("public/robots.txt");

  assert.match(robots, /^User-agent: \*$/m);
  assert.match(robots, /^Allow: \/$/m);
  assert.match(robots, /^Sitemap: https:\/\/www\.kailanibodywork\.com\/sitemap\.xml$/m);
});

test("sitemap contains canonical public URLs only", () => {
  const sitemap = read("public/sitemap.xml");
  const urls = Array.from(sitemap.matchAll(/<loc>(.*?)<\/loc>/g), (match) => match[1]);

  assert.match(sitemap, /<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
  assert.match(sitemap, /<loc>https:\/\/www\.kailanibodywork\.com\/<\/loc>/);
  assert.deepEqual(urls, [CANONICAL_URL]);
  for (const url of urls) {
    assert.doesNotMatch(url, new RegExp("/approve|/api/|\\?|vercel\\.app|" + OLD_DOMAIN.source, "i"));
  }
});

test("SEO changes do not alter booking feature-flag behavior", () => {
  const bookingSource = read("src/components/Booking.jsx");

  assert.match(bookingSource, /bookingRequestsEnabled\(import\.meta\.env\)/);
  assert.match(bookingSource, /<SquareBooking \/>/);
});
