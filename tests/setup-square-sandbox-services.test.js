import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DESIRED_SERVICES,
  buildCatalogBatch,
  validateConfig,
  readConfig,
  looksLikeApplicationId,
  detectDuplicates,
  mapToReport,
  runSetup,
  REPORT_FILE,
} from "../scripts/setup-square-sandbox-services.mjs";

const TOKEN = "EAAAl-test-access-token";

const VALID_CONFIG = {
  accessToken: TOKEN,
  environment: "sandbox",
  locationId: "LOC_TEST",
  teamMemberId: "TM_CHELSEA",
  applyCatalog: false,
};

function materialize(objects) {
  const idMap = {};
  for (const object of objects) {
    idMap[object.id] = `REAL_${object.id.slice(1)}`;
    for (const variation of (object.itemData && object.itemData.variations) || []) {
      idMap[variation.id] = `REAL_${variation.id.slice(1)}`;
    }
  }
  const replacer = (_key, value) => (typeof value === "bigint" ? Number(value) : value);
  return objects.map((object) => {
    const copy = JSON.parse(JSON.stringify(object, replacer));
    copy.id = idMap[object.id];
    copy.itemData.variations = copy.itemData.variations.map((variation) => ({
      ...variation,
      id: idMap[variation.id],
    }));
    return copy;
  });
}

function materializeResponses(batchObjects) {
  const idMappings = batchObjects.map((object) => ({
    clientObjectId: object.id,
    objectId: `REAL_${object.id.slice(1)}`,
  }));
  const items = materialize(batchObjects);
  return { idMappings, items };
}

function makeFakeClient(overrides = {}) {
  return {
    locations: {
      list: overrides.locationsList || (async () => ({ locations: [{ id: "LOC_TEST", name: "Kai Lani Sandbox", status: "ACTIVE" }] })),
    },
    teamMembers: {
      search: overrides.teamMembersSearch || (async () => ({ teamMembers: [{ id: "TM_CHELSEA", givenName: "Chelsea", familyName: "Teller" }] })),
    },
    bookings: {
      teamMemberProfiles: {
        get: overrides.teamMemberProfileGet || (async () => ({ teamMemberBookingProfile: { teamMemberId: "TM_CHELSEA", displayName: "Chelsea Teller", isBookable: true } })),
      },
    },
    catalog: {
      searchItems: overrides.searchItems || (async () => ({ items: [] })),
      batchUpsert: overrides.batchUpsert || (async () => { throw new Error("batchUpsert must not be called"); }),
      batchGet: overrides.batchGet || (async () => { throw new Error("batchGet must not be called"); }),
    },
  };
}

function tempDir() {
  return mkdtempSync(join(tmpdir(), "kai-lani-sq-"));
}

test("refuses any environment other than sandbox", () => {
  for (const environment of ["production", "PRODUCTION", "", "staging"]) {
    const result = validateConfig({ ...VALID_CONFIG, environment });
    assert.equal(result.ok, false, `environment "${environment}" must be refused`);
    assert.match(result.error, /sandbox/i);
  }
});

test("stops safely when the token is missing", () => {
  const result = validateConfig({ ...VALID_CONFIG, accessToken: "" });
  assert.equal(result.ok, false);
  assert.match(result.error, /SQUARE_ACCESS_TOKEN/);
});

test("rejects the Square Application ID as an access token", () => {
  assert.equal(looksLikeApplicationId("sandbox-sq0idb-E53xW6EpMuFB4edXZGx7qw"), true);
  assert.equal(looksLikeApplicationId("sq0idb-something"), true);
  assert.equal(looksLikeApplicationId(TOKEN), false);
  const result = validateConfig({
    ...VALID_CONFIG,
    accessToken: "sandbox-sq0idb-E53xW6EpMuFB4edXZGx7qw",
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /Application ID/i);
});

test("stops safely when location or team member is missing", () => {
  const noLocation = validateConfig({ ...VALID_CONFIG, locationId: "" });
  assert.equal(noLocation.ok, false);
  assert.match(noLocation.error, /SQUARE_LOCATION_ID/);

  const noTeamMember = validateConfig({ ...VALID_CONFIG, teamMemberId: "" });
  assert.equal(noTeamMember.ok, false);
  assert.match(noTeamMember.error, /SQUARE_TEAM_MEMBER_ID/);
});

test("SQUARE_APPLY_CATALOG requires the exact value true", () => {
  for (const value of ["", "false", "1", "yes", "TRUE", " true "]) {
    const config = readConfig({
      SQUARE_APPLY_CATALOG: value,
      SQUARE_ENVIRONMENT: "sandbox",
      SQUARE_ACCESS_TOKEN: TOKEN,
      SQUARE_LOCATION_ID: "LOC_TEST",
      SQUARE_TEAM_MEMBER_ID: "TM_CHELSEA",
    });
    assert.equal(config.applyCatalog, false, `SQUARE_APPLY_CATALOG="${value}" must not enable apply`);
  }
  const applied = readConfig({
    SQUARE_APPLY_CATALOG: "true",
    SQUARE_ENVIRONMENT: "sandbox",
    SQUARE_ACCESS_TOKEN: TOKEN,
    SQUARE_LOCATION_ID: "LOC_TEST",
    SQUARE_TEAM_MEMBER_ID: "TM_CHELSEA",
  });
  assert.equal(applied.applyCatalog, true);
});

test("dry run performs no writes", async () => {
  let wrote = false;
  const client = makeFakeClient({
    batchUpsert: async () => {
      wrote = true;
      throw new Error("should not be reached");
    },
  });
  const result = await runSetup({ client, config: VALID_CONFIG, cwd: tempDir() });
  assert.equal(wrote, false);
  assert.equal(result.exitCode, 0);
});

test("dry run reports a missing location and performs no writes", async () => {
  let wrote = false;
  const client = makeFakeClient({
    locationsList: async () => ({ locations: [] }),
    batchUpsert: async () => {
      wrote = true;
      throw new Error("should not be reached");
    },
  });
  const result = await runSetup({ client, config: VALID_CONFIG, cwd: tempDir() });
  assert.equal(wrote, false);
  assert.equal(result.exitCode, 1);
  assert.ok(result.logs.some((line) => /BLOCKED/i.test(line) && /Location/i.test(line)));
});

test("dry run reports an unknown team member and performs no writes", async () => {
  let wrote = false;
  const client = makeFakeClient({
    teamMembersSearch: async () => ({ teamMembers: [] }),
    batchUpsert: async () => {
      wrote = true;
      throw new Error("should not be reached");
    },
  });
  const result = await runSetup({ client, config: VALID_CONFIG, cwd: tempDir() });
  assert.equal(wrote, false);
  assert.equal(result.exitCode, 1);
  assert.ok(result.logs.some((line) => /BLOCKED/i.test(line) && /Team member/i.test(line)));
});

test("dry run reports a non-bookable team member", async () => {
  const client = makeFakeClient({
    teamMemberProfileGet: async () => ({ teamMemberBookingProfile: { teamMemberId: "TM_CHELSEA", isBookable: false } }),
  });
  const result = await runSetup({ client, config: VALID_CONFIG, cwd: tempDir() });
  assert.equal(result.exitCode, 1);
  assert.ok(result.logs.some((line) => /BLOCKED/i.test(line) && /bookable/i.test(line)));
});

test("builds exactly three items and five variations", () => {
  const { objects } = buildCatalogBatch(VALID_CONFIG, { locationId: "LOC_TEST", teamMemberId: "TM_CHELSEA" });
  assert.equal(objects.length, 3);
  const itemNames = objects.map((object) => object.itemData.name).sort();
  assert.deepEqual(itemNames, [
    "Customized Deep Tissue Massage",
    "Customized Massage",
    "Customized Prenatal Massage",
  ]);
  const variations = objects.flatMap((object) => object.itemData.variations);
  assert.equal(variations.length, 5);
  for (const object of objects) {
    assert.equal(object.type, "ITEM");
    assert.equal(object.itemData.productType, "APPOINTMENTS_SERVICE");
    assert.equal(object.presentAtAllLocations, false);
    assert.deepEqual(object.presentAtLocationIds, ["LOC_TEST"]);
    assert.ok(object.id.startsWith("#"));
    for (const variation of object.itemData.variations) {
      assert.equal(variation.type, "ITEM_VARIATION");
      assert.equal(variation.itemVariationData.itemId, object.id);
      assert.equal(variation.presentAtAllLocations, false);
      assert.deepEqual(variation.presentAtLocationIds, ["LOC_TEST"]);
      assert.equal(variation.itemVariationData.availableForBooking, true);
      assert.equal(variation.itemVariationData.sellable, true);
      assert.equal(variation.itemVariationData.stockable, true);
      assert.deepEqual(variation.itemVariationData.teamMemberIds, ["TM_CHELSEA"]);
    }
  }
});

test("uses the correct cent values and millisecond durations", () => {
  const { objects } = buildCatalogBatch(VALID_CONFIG, { locationId: "LOC_TEST", teamMemberId: "TM_CHELSEA" });
  const variations = objects.flatMap((object) => object.itemData.variations);
  const prices = variations.map((v) => v.itemVariationData.priceMoney.amount).sort((a, b) => (a < b ? -1 : 1));
  assert.deepEqual(prices, [9300n, 9300n, 9700n, 12300n, 12300n]);
  const durations = variations.map((v) => v.itemVariationData.serviceDuration).sort((a, b) => (a < b ? -1 : 1));
  assert.deepEqual(durations, [3600000n, 3600000n, 3600000n, 5400000n, 5400000n]);
  for (const variation of variations) {
    assert.equal(variation.itemVariationData.priceMoney.currency, "USD");
    assert.equal(variation.itemVariationData.pricingType, "FIXED_PRICING");
  }
});

test("detects exact-name duplicates and does not plan overwrites", () => {
  const existingItems = [
    {
      type: "ITEM",
      id: "EXISTING_ITEM_1",
      itemData: {
        name: "Customized Massage",
        variations: [
          {
            type: "ITEM_VARIATION",
            id: "EXISTING_VAR_60",
            itemVariationData: { name: "60 Minutes", serviceDuration: 3600000, priceMoney: { amount: 9300, currency: "USD" } },
          },
        ],
      },
    },
  ];
  const result = detectDuplicates(DESIRED_SERVICES, existingItems);
  assert.equal(result.duplicates.length, 1);
  assert.equal(result.duplicates[0].itemName, "Customized Massage");
  assert.equal(result.duplicates[0].existingItemId, "EXISTING_ITEM_1");
  assert.equal(result.duplicates[0].existingVariations[0].id, "EXISTING_VAR_60");
  assert.equal(result.report.find((entry) => entry.itemName === "Customized Deep Tissue Massage").status, "new");
});

test("apply mode refuses to write when an exact-name duplicate exists", async () => {
  const existingItems = [
    {
      type: "ITEM",
      id: "EXISTING_ITEM_1",
      itemData: {
        name: "Customized Massage",
        variations: [
          {
            type: "ITEM_VARIATION",
            id: "EXISTING_VAR_60",
            itemVariationData: { name: "60 Minutes", serviceDuration: 3600000, priceMoney: { amount: 9300, currency: "USD" } },
          },
        ],
      },
    },
  ];
  let wrote = false;
  const client = makeFakeClient({
    searchItems: async () => ({ items: existingItems }),
    batchUpsert: async () => {
      wrote = true;
      throw new Error("should not be reached");
    },
  });
  const result = await runSetup({ client, config: { ...VALID_CONFIG, applyCatalog: true }, cwd: tempDir() });
  assert.equal(wrote, false);
  assert.equal(result.exitCode, 1);
  assert.ok(result.logs.some((line) => /DUPLICATE PROTECTION/i.test(line)));
});

test("apply mode writes, verifies, and writes only the safe ID report", async () => {
  const { objects } = buildCatalogBatch(VALID_CONFIG, { locationId: "LOC_TEST", teamMemberId: "TM_CHELSEA" });
  const { idMappings, items } = materializeResponses(objects);
  const client = makeFakeClient({
    batchUpsert: async (request) => {
      assert.ok(request.idempotencyKey);
      assert.equal(request.batches.length, 1);
      assert.equal(request.batches[0].objects.length, 3);
      return { idMappings };
    },
    batchGet: async (request) => {
      assert.equal(request.includeRelatedObjects, true);
      return { objects: items };
    },
  });
  const dir = tempDir();
  const result = await runSetup({ client, config: { ...VALID_CONFIG, applyCatalog: true }, cwd: dir });

  assert.equal(result.exitCode, 0);
  const reportPath = join(dir, REPORT_FILE);
  assert.equal(existsSync(reportPath), true);
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  assert.deepEqual(Object.keys(report).sort(), [
    "customized_60",
    "customized_90",
    "deep_tissue_60",
    "deep_tissue_90",
    "prenatal_60",
  ]);
  for (const value of Object.values(report)) assert.ok(typeof value === "string" && value.length > 0);
  rmSync(dir, { recursive: true, force: true });
});

test("mapToReport produces only the five safe keys", () => {
  const { objects } = buildCatalogBatch(VALID_CONFIG, { locationId: "LOC_TEST", teamMemberId: "TM_CHELSEA" });
  const { items } = materializeResponses(objects);
  const variations = [];
  for (const item of items) {
    for (const variation of item.itemData.variations) variations.push({ itemId: item.id, ...variation });
  }
  const report = mapToReport({ items, variations });
  assert.deepEqual(Object.keys(report).sort(), [
    "customized_60",
    "customized_90",
    "deep_tissue_60",
    "deep_tissue_90",
    "prenatal_60",
  ]);
  for (const value of Object.values(report)) assert.ok(value.startsWith("REAL_KL_VAR_"));
});

test("verification fails when retrieved objects do not match", async () => {
  const { objects } = buildCatalogBatch(VALID_CONFIG, { locationId: "LOC_TEST", teamMemberId: "TM_CHELSEA" });
  const { idMappings } = materializeResponses(objects);
  const mismatched = materialize(objects);
  mismatched[0].itemData.variations[0].itemVariationData.priceMoney.amount = 1;
  const client = makeFakeClient({
    batchUpsert: async () => ({ idMappings }),
    batchGet: async () => ({ objects: mismatched }),
  });
  const result = await runSetup({ client, config: { ...VALID_CONFIG, applyCatalog: true }, cwd: tempDir() });
  assert.equal(result.exitCode, 1);
  assert.ok(result.logs.some((line) => /VERIFICATION FAILED/i.test(line)));
});

test("the token never appears in any output", async () => {
  const client = makeFakeClient();
  const result = await runSetup({ client, config: VALID_CONFIG, cwd: tempDir() });
  const combined = result.logs.join("\n");
  assert.equal(combined.includes(TOKEN), false);
  assert.equal(combined.includes("EAAAl"), false);
});
