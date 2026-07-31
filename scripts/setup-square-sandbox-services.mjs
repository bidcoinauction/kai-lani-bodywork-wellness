import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import square from "square";

const { SquareClient, SquareEnvironment } = square;

const CURRENT_FILE = fileURLToPath(import.meta.url);

export const REPORT_FILE = "square-sandbox-service-ids.json";

export const DESCRIPTIONS = {
  "Customized Massage":
    "A personalized full-body session tailored to your needs, blending therapeutic techniques to relieve tension, improve mobility, and support overall relaxation.",
  "Customized Deep Tissue Massage":
    "Focused deep tissue work customized to areas of chronic tension, soreness, and restricted movement to support relief and recovery.",
  "Customized Prenatal Massage":
    "A supportive prenatal massage tailored for comfort and relaxation during pregnancy, with positioning and pressure adapted to the client's needs.",
};

export const DESIRED_SERVICES = [
  { key: "customized_60", itemName: "Customized Massage", variationName: "60 Minutes", durationMinutes: 60, priceCents: 9300 },
  { key: "customized_90", itemName: "Customized Massage", variationName: "90 Minutes", durationMinutes: 90, priceCents: 12300 },
  { key: "deep_tissue_60", itemName: "Customized Deep Tissue Massage", variationName: "60 Minutes", durationMinutes: 60, priceCents: 9300 },
  { key: "deep_tissue_90", itemName: "Customized Deep Tissue Massage", variationName: "90 Minutes", durationMinutes: 90, priceCents: 12300 },
  { key: "prenatal_60", itemName: "Customized Prenatal Massage", variationName: "60 Minutes", durationMinutes: 60, priceCents: 9700 },
];

function slug(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

export function looksLikeApplicationId(token) {
  if (typeof token !== "string") return false;
  return /^(sandbox-)?sq0idb-/i.test(token.trim());
}

export function readConfig(env) {
  return {
    accessToken: (env.SQUARE_ACCESS_TOKEN || "").trim(),
    environment: (env.SQUARE_ENVIRONMENT || "").trim().toLowerCase(),
    locationId: (env.SQUARE_LOCATION_ID || "").trim(),
    teamMemberId: (env.SQUARE_TEAM_MEMBER_ID || "").trim(),
    applyCatalog: env.SQUARE_APPLY_CATALOG === "true",
  };
}

export function validateConfig(config) {
  if (config.environment !== "sandbox") {
    return {
      ok: false,
      error:
        'SQUARE_ENVIRONMENT must equal "sandbox". Production Square is never allowed by this script.',
    };
  }
  if (!config.accessToken) {
    return { ok: false, error: "Missing SQUARE_ACCESS_TOKEN. Stopping safely." };
  }
  if (looksLikeApplicationId(config.accessToken)) {
    return {
      ok: false,
      error:
        "SQUARE_ACCESS_TOKEN looks like a Square Application ID, not an access token. Stopping safely.",
    };
  }
  if (!config.locationId) {
    return { ok: false, error: "Missing SQUARE_LOCATION_ID. Stopping safely." };
  }
  if (!config.teamMemberId) {
    return { ok: false, error: "Missing SQUARE_TEAM_MEMBER_ID. Stopping safely." };
  }
  return { ok: true };
}

export function createClient(accessToken) {
  return new SquareClient({
    token: accessToken,
    environment: SquareEnvironment.Sandbox,
  });
}

function toMinutes(ms) {
  return ms == null ? null : Math.round(Number(ms) / 60_000);
}

function toCents(money) {
  return money && money.amount != null ? Number(money.amount) : null;
}

export function buildCatalogBatch(config, { locationId, teamMemberId }) {
  const items = [];
  const byItem = new Map();

  for (const service of DESIRED_SERVICES) {
    let group = byItem.get(service.itemName);
    if (!group) {
      group = {
        objectId: `#KL_ITEM_${slug(service.itemName)}`,
        services: [],
      };
      byItem.set(service.itemName, group);
    }
    group.services.push(service);
  }

  for (const [itemName, group] of byItem) {
    const variations = group.services.map((service) => ({
      type: "ITEM_VARIATION",
      id: `#KL_VAR_${service.key}`,
      presentAtAllLocations: false,
      presentAtLocationIds: [locationId],
      itemVariationData: {
        itemId: group.objectId,
        name: service.variationName,
        pricingType: "FIXED_PRICING",
        priceMoney: { amount: BigInt(service.priceCents), currency: "USD" },
        serviceDuration: BigInt(service.durationMinutes * 60_000),
        availableForBooking: true,
        sellable: true,
        stockable: true,
        teamMemberIds: [teamMemberId],
      },
    }));

    items.push({
      type: "ITEM",
      id: group.objectId,
      presentAtAllLocations: false,
      presentAtLocationIds: [locationId],
      itemData: {
        name: itemName,
        description: DESCRIPTIONS[itemName],
        productType: "APPOINTMENTS_SERVICE",
        variations,
      },
    });
  }

  return { objects: items };
}

export function summarizeErrors(errors = []) {
  return errors
    .map((error) => `${error.code || "ERROR"} ${error.detail || ""}`.trim())
    .filter(Boolean)
    .join("; ");
}

function errorDetail(error) {
  if (error && error.body && Array.isArray(error.body.errors)) {
    const parts = error.body.errors
      .map((entry) => `${entry.code || "ERROR"} ${entry.detail || ""}`.trim())
      .filter(Boolean);
    if (parts.length > 0) return parts.join("; ");
  }
  return error && error.message ? String(error.message) : String(error);
}

export function safeErrorMessage(error, redactToken) {
  const raw = errorDetail(error);
  let text = raw.slice(0, 300);
  if (redactToken && text.includes(redactToken)) {
    text = text.split(redactToken).join("[REDACTED]");
  }
  return text;
}

export function groupDesiredByItem(desired = DESIRED_SERVICES) {
  const byItem = new Map();
  for (const service of desired) {
    let group = byItem.get(service.itemName);
    if (!group) {
      group = { itemName: service.itemName, services: [] };
      byItem.set(service.itemName, group);
    }
    group.services.push(service);
  }
  return Array.from(byItem.values());
}

export function detectDuplicates(desired, existingItems) {
  const existingByName = new Map();
  for (const item of existingItems || []) {
    const name = item.itemData && item.itemData.name;
    if (name) existingByName.set(name, item);
  }

  const report = groupDesiredByItem(desired).map((group) => {
    const existing = existingByName.get(group.itemName);
    if (!existing) {
      return { itemName: group.itemName, status: "new" };
    }
    const existingVariations = (existing.itemData.variations || []).map((variation) => {
      const data = variation.itemVariationData || {};
      return {
        id: variation.id,
        name: data.name,
        durationMinutes: toMinutes(data.serviceDuration),
        priceCents: toCents(data.priceMoney),
      };
    });
    const matchesExisting = group.services.every((service) =>
      existingVariations.some(
        (variation) =>
          variation.name === service.variationName &&
          variation.durationMinutes === service.durationMinutes &&
          variation.priceCents === service.priceCents,
      ),
    );
    return {
      itemName: group.itemName,
      status: "existing",
      existingItemId: existing.id,
      existingVariations,
      duplicate: true,
      matchesExisting,
    };
  });

  return { report, duplicates: report.filter((entry) => entry.status === "existing") };
}

export async function collectContext(client, config) {
  const context = {
    location: null,
    locationError: null,
    teamMember: null,
    teamMemberError: null,
    bookingProfile: null,
    bookingProfileError: null,
    existingItems: [],
    catalogError: null,
  };

  try {
    const { locations } = await client.locations.list();
    const found = (locations || []).find((location) => location.id === config.locationId);
    if (!found) {
      context.locationError = `Location ${config.locationId} was not found.`;
    } else if (found.status !== "ACTIVE") {
      context.locationError = `Location ${config.locationId} is not active (status: ${found.status}).`;
    } else {
      context.location = { id: found.id, name: found.name, status: found.status };
    }
  } catch (error) {
    context.locationError = safeErrorMessage(error, config.accessToken);
  }

  try {
    const { teamMembers } = await client.teamMembers.search({
      query: { filter: { status: "ACTIVE" } },
    });
    const found = (teamMembers || []).find((member) => member.id === config.teamMemberId);
    if (!found) {
      context.teamMemberError = `Team member ${config.teamMemberId} was not found or is not ACTIVE.`;
    } else {
      const displayName = [found.givenName, found.familyName].filter(Boolean).join(" ").trim();
      context.teamMember = {
        id: found.id,
        displayName: displayName || found.id,
      };
    }
  } catch (error) {
    context.teamMemberError = safeErrorMessage(error, config.accessToken);
  }

  if (context.teamMember) {
    try {
      const { teamMemberBookingProfile } = await client.bookings.teamMemberProfiles.get({
        teamMemberId: config.teamMemberId,
      });
      context.bookingProfile = teamMemberBookingProfile || null;
      if (!teamMemberBookingProfile || teamMemberBookingProfile.isBookable !== true) {
        context.bookingProfileError = `Team member ${config.teamMemberId} is not bookable for Appointments.`;
      }
    } catch (error) {
      context.bookingProfileError = safeErrorMessage(error, config.accessToken);
    }
  }

  try {
    const { items } = await client.catalog.searchItems({
      productTypes: ["APPOINTMENTS_SERVICE"],
    });
    context.existingItems = items || [];
  } catch (error) {
    context.catalogError = safeErrorMessage(error, config.accessToken);
  }

  return context;
}

function formatPrice(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}

function formatDuration(minutes) {
  return `${minutes} min`;
}

function planLines(desired, duplicates) {
  const byKey = new Map();
  for (const entry of duplicates.report) byKey.set(entry.itemName, entry);

  const lines = [];
  for (const group of groupDesiredByItem(desired)) {
    const entry = byKey.get(group.itemName);
    const status = entry ? entry.status : "new";
    lines.push(`- ${group.itemName} [${status}]`);
    for (const service of group.services) {
      lines.push(
        `    - ${service.variationName} — ${formatDuration(service.durationMinutes)} — ${formatPrice(service.priceCents)}`,
      );
    }
    if (entry && entry.status === "existing") {
      lines.push(`    Existing item ID: ${entry.existingItemId}`);
      for (const variation of entry.existingVariations) {
        const duration = variation.durationMinutes == null ? "?" : formatDuration(variation.durationMinutes);
        const price = variation.priceCents == null ? "?" : formatPrice(variation.priceCents);
        lines.push(
          `    Existing variation: ${variation.name || "?"} — ${duration} — ${price} (${variation.id})`,
        );
      }
      lines.push(
        entry.matchesExisting
          ? "    Matches desired configuration."
          : "    DIFFERS from desired configuration (durations/prices/names).",
      );
    }
  }
  return lines;
}

export async function verifyCreated(client, itemIds, config) {
  const { objects } = await client.catalog.batchGet({
    objectIds: itemIds,
    includeRelatedObjects: true,
  });

  const items = (objects || []).filter(
    (object) => object.type === "ITEM" && object.itemData,
  );
  const variations = [];
  for (const item of items) {
    for (const variation of item.itemData.variations || []) {
      variations.push({ itemId: item.id, ...variation });
    }
  }

  const checks = [];
  if (items.length !== 3) checks.push(`expected 3 ITEM objects, got ${items.length}`);
  if (variations.length !== 5) checks.push(`expected 5 ITEM_VARIATION objects, got ${variations.length}`);

  for (const service of DESIRED_SERVICES) {
    const item = items.find((candidate) => candidate.itemData.name === service.itemName);
    if (!item) {
      checks.push(`missing item "${service.itemName}"`);
      continue;
    }
    if (item.itemData.productType !== "APPOINTMENTS_SERVICE") {
      checks.push(`"${service.itemName}" productType is not APPOINTMENTS_SERVICE`);
    }
    if (item.presentAtAllLocations !== false) {
      checks.push(`"${service.itemName}" presentAtAllLocations is not false`);
    }
    if (!(item.presentAtLocationIds || []).includes(config.locationId)) {
      checks.push(`"${service.itemName}" is not present at ${config.locationId}`);
    }
    const variation = variations.find(
      (candidate) =>
        candidate.itemId === item.id &&
        candidate.itemVariationData &&
        candidate.itemVariationData.name === service.variationName,
    );
    if (!variation) {
      checks.push(`missing variation "${service.itemName} / ${service.variationName}"`);
      continue;
    }
    const data = variation.itemVariationData;
    if (toCents(data.priceMoney) !== service.priceCents) {
      checks.push(`"${service.key}" price mismatch`);
    }
    if (toMinutes(data.serviceDuration) !== service.durationMinutes) {
      checks.push(`"${service.key}" duration mismatch`);
    }
    if (data.availableForBooking !== true) {
      checks.push(`"${service.key}" availableForBooking is not true`);
    }
    if (!(data.teamMemberIds || []).includes(config.teamMemberId)) {
      checks.push(`"${service.key}" is not assigned to team member ${config.teamMemberId}`);
    }
  }

  if (checks.length > 0) return { ok: false, error: checks.join("; ") };
  return { ok: true, items, variations };
}

export function mapToReport(verify) {
  const report = {};
  for (const service of DESIRED_SERVICES) {
    const item = verify.items.find((candidate) => candidate.itemData.name === service.itemName);
    const variation =
      item &&
      verify.variations.find(
        (candidate) =>
          candidate.itemId === item.id &&
          candidate.itemVariationData &&
          candidate.itemVariationData.name === service.variationName,
      );
    report[service.key] = variation ? variation.id : null;
  }
  return report;
}

export function loadDotEnv(baseEnv = process.env, cwd = process.cwd()) {
  const parsed = {};
  for (const file of [".env", ".env.local"]) {
    try {
      const text = readFileSync(resolve(cwd, file), "utf8");
      for (const line of text.split(/\r?\n/)) {
        const match = line.match(/^([A-Za-z0-9_]+)=(.*)$/);
        if (match) parsed[match[1]] = match[2].trim();
      }
    } catch {
      // File absent or unreadable — ignore.
    }
  }
  return { ...parsed, ...baseEnv };
}

export async function runSetup({ client, config, cwd = process.cwd() }) {
  const logs = [];
  const info = (line) => logs.push(line);

  const validation = validateConfig(config);
  if (!validation.ok) {
    info(`ERROR: ${validation.error}`);
    return { exitCode: 1, logs };
  }

  const mode = config.applyCatalog ? "APPLY" : "DRY RUN";
  info(`Kai Lani Square Sandbox catalog setup — ${mode}`);
  info(`Square environment: sandbox (hard-coded; Production is never allowed)`);

  const context = await collectContext(client, config);
  const duplicates = detectDuplicates(DESIRED_SERVICES, context.existingItems);

  info("");
  info(`Location: ${context.location ? `${context.location.name} (${context.location.id}, ${context.location.status})` : "NOT VERIFIED"}`);
  if (context.locationError) info(`  BLOCKED: ${context.locationError}`);

  info("");
  info(`Team member: ${context.teamMember ? `${context.teamMember.displayName} (${context.teamMember.id})` : "NOT VERIFIED"}`);
  if (context.teamMemberError) info(`  BLOCKED: ${context.teamMemberError}`);
  if (context.teamMember && !context.bookingProfileError) {
    info(`  Booking profile: bookable`);
  }
  if (context.bookingProfileError) info(`  BLOCKED: ${context.bookingProfileError}`);

  info("");
  info(`Existing APPOINTMENTS_SERVICE items: ${context.existingItems.length}`);
  if (context.catalogError) info(`  BLOCKED: ${context.catalogError}`);

  info("");
  info("Proposed services and variations:");
  for (const line of planLines(DESIRED_SERVICES, duplicates)) info(line);

  if (duplicates.duplicates.length > 0) {
    info("");
    info(
      `DUPLICATE PROTECTION: ${duplicates.duplicates.length} service name(s) already exist. ` +
        "No objects will be created or overwritten. Resolve manually before applying.",
    );
  }

  const hardFail =
    Boolean(context.locationError) ||
    Boolean(context.teamMemberError) ||
    Boolean(context.bookingProfileError) ||
    Boolean(context.catalogError);

  if (!config.applyCatalog) {
    info("");
    info(hardFail ? "Dry run finished with blockers — no writes performed." : "Dry run complete — no writes performed.");
    return { exitCode: hardFail ? 1 : 0, logs };
  }

  if (hardFail || duplicates.duplicates.length > 0) {
    info("");
    info("Apply aborted — preconditions not met. No writes performed.");
    return { exitCode: 1, logs };
  }

  info("");
  info("Applying catalog changes to Square Sandbox...");
  try {
    const { objects } = buildCatalogBatch(config, {
      locationId: config.locationId,
      teamMemberId: config.teamMemberId,
    });

    const response = await client.catalog.batchUpsert({
      idempotencyKey: randomUUID(),
      batches: [{ objects }],
    });

    if (response.errors && response.errors.length > 0) {
      info(`ERROR: BatchUpsertCatalogObjects failed: ${summarizeErrors(response.errors)}`);
      return { exitCode: 1, logs };
    }

    const mappings = {};
    for (const mapping of response.idMappings || []) {
      if (mapping.clientObjectId && mapping.objectId) mappings[mapping.clientObjectId] = mapping.objectId;
    }
    const itemIds = objects.map((object) => mappings[object.id]).filter(Boolean);
    if (itemIds.length !== objects.length) {
      info("ERROR: Square did not return permanent IDs for all created objects.");
      return { exitCode: 1, logs };
    }

    info("Verifying created objects against Square...");
    const verify = await verifyCreated(client, itemIds, config);
    if (!verify.ok) {
      info(`VERIFICATION FAILED: ${verify.error}`);
      info("Do not trust the write. Review the Sandbox catalog manually.");
      return { exitCode: 1, logs };
    }

    const report = mapToReport(verify);
    const missing = Object.keys(report).filter((key) => !report[key]);
    if (missing.length > 0) {
      info(`VERIFICATION FAILED: missing variation IDs for: ${missing.join(", ")}`);
      return { exitCode: 1, logs };
    }

    const reportPath = resolve(cwd, REPORT_FILE);
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    info(`Wrote ${REPORT_FILE}. This file is gitignored — do not commit or share it.`);
    return { exitCode: 0, logs };
  } catch (error) {
    info(`ERROR: ${safeErrorMessage(error, config.accessToken)}`);
    return { exitCode: 1, logs };
  }
}

async function runCli() {
  const config = readConfig(loadDotEnv());
  const validation = validateConfig(config);
  if (!validation.ok) {
    console.error(validation.error);
    process.exit(1);
  }
  const client = createClient(config.accessToken);
  const { exitCode, logs } = await runSetup({ client, config });
  for (const line of logs) console.log(line);
  process.exit(exitCode);
}

if (resolve(process.argv[1] || "") === CURRENT_FILE) {
  runCli();
}
