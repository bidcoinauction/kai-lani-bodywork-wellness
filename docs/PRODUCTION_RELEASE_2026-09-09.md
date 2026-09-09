# Production Release 2026-09-09

## Baseline

- Production commit: `2c2284bd1c7af0c01838b12acc26cde7be7f7f67`
- Vercel deployment: `dpl_D7ANzk9RdEiYa1d1FoMG3SGaE3oq`
- Canonical site: `https://www.kailanibodywork.com/`
- Business: Kai Lani Bodywork & Wellness
- Provider: Chelsea Teller
- Public email: `appointments@kailanibodywork.com`
- Official address: 106 S Main St, Suite F, Mount Holly, NC 28120

## Database

- Production Neon migration `005_optional_prepayment.sql` was applied successfully.
- The migration added optional prepayment reference columns and indexes only.
- Historical payment fields remained unused/default after migration.
- Booking status counts were unchanged after migration.

## Optional Prepayment

- Optional Square prepayment is enabled in Production.
- Payment remains optional; clients may still pay at their appointment.
- Checkout is Square-hosted.
- Kai Lani does not handle or store raw card data.
- Pricing is server-authoritative; browser-supplied amounts are ignored.
- No Production Square payment link, order, or payment was created solely for rollout testing.

## Public Identity And Arrival

- Public contact email is `appointments@kailanibodywork.com`.
- Bolton's Curbside Cookery is used as an arrival landmark only.
- Bolton's address is not used as Kai Lani's official address.
- Official Kai Lani address remains 106 S Main St, Suite F.
- Arrival directions preserve the Uptown Salon drive, rear black metal staircase, ground-level Suite F entrance, and instruction not to go upstairs.

## Verification

- `npm test`: 337/337 passing
- `node --test "tests/prepay.test.js"`: 8/8 passing
- `npm run build`: passing
- Vercel Production deployment reached READY.
- Canonical site and payment routes loaded successfully.
- Invalid prepay access rejected safely.
- No Sandbox Square URLs, Default Test Account references, temporary migration route, or raw card form were exposed publicly.

## Secrets And PII

- This release record intentionally contains no database credentials, Square credentials, tokens, or client PII.
