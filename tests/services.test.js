import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SQUARE_SERVICES,
  SERVICE_KEYS,
  getServiceConfig,
  isServiceKey,
} from "../api/lib/services.js";
import { clearSquareEnv, installFullConfig } from "./helpers.js";

test("known service keys return a server-owned config", () => {
  installFullConfig();
  const keys = Object.keys(SQUARE_SERVICES);
  assert.deepEqual(
    keys.sort(),
    [
      "customized_60",
      "deep_tissue_60",
      "prenatal_60",
      "customized_90",
      "deep_tissue_90",
    ].sort(),
  );
  assert.equal(SERVICE_KEYS.length, 5);

  const customized = getServiceConfig("customized_60");
  assert.equal(customized.name, "60 Min Customized Massage");
  assert.equal(customized.durationMinutes, 60);
  assert.equal(customized.price, 93);
  assert.equal(customized.serviceVariationId, "VAR_CUSTOMIZED_60");

  const prenatal = getServiceConfig("prenatal_60");
  assert.equal(prenatal.name, "60 Min Customized Prenatal Massage");
  assert.equal(prenatal.durationMinutes, 60);
  assert.equal(prenatal.price, 97);

  const deep90 = getServiceConfig("deep_tissue_90");
  assert.equal(deep90.name, "90 Min Customized Deep Tissue Massage");
  assert.equal(deep90.durationMinutes, 90);
  assert.equal(deep90.price, 123);
});

test("unknown service keys return null", () => {
  assert.equal(getServiceConfig("customized-60"), null);
  assert.equal(getServiceConfig("unknown_service"), null);
  assert.equal(getServiceConfig("customized_120"), null);
  assert.equal(getServiceConfig(""), null);
  assert.equal(isServiceKey("customized_60"), true);
  assert.equal(isServiceKey("not-a-service"), false);
});

test("serviceVariationId is null when its environment variable is missing", () => {
  clearSquareEnv();
  const config = getServiceConfig("prenatal_60");
  assert.equal(config.serviceVariationId, null);
  assert.equal(config.variationIdEnv, "SQUARE_SERVICE_PRENATAL_60_ID");
});
