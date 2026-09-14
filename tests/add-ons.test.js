import { test } from "node:test";
import assert from "node:assert/strict";
import { getAddOnConfig, isExactFacialMassageAddOnVariation } from "../lib/add-ons.js";
import { mapMassageBookService } from "../lib/massagebook-migration.js";

test("Facial Massage add-on is exactly 15 minutes and $30", () => {
  const addOn = getAddOnConfig("facial_massage_15");
  assert.equal(addOn.itemName, "Facial Massage Add-On");
  assert.equal(addOn.variationName, "15 MIN FACIAL MASSAGE ADD-ON");
  assert.equal(addOn.durationMinutes, 15);
  assert.equal(addOn.price, 30);
  assert.equal(addOn.priceCents, 3000);
  assert.equal(addOn.currency, "USD");
});

test("Facial Massage add-on exact matcher requires name, duration, price, and currency", () => {
  const variation = {
    itemVariationData: {
      name: "15 MIN FACIAL MASSAGE ADD-ON",
      serviceDuration: 900000n,
      priceMoney: { amount: 3000n, currency: "USD" },
    },
  };
  assert.equal(isExactFacialMassageAddOnVariation({ itemName: "Facial Massage Add-On", variation }), true);
  assert.equal(isExactFacialMassageAddOnVariation({ itemName: "Facial Massage", variation }), false);
  assert.equal(isExactFacialMassageAddOnVariation({ itemName: "Facial Massage Add-On", variation: { itemVariationData: { ...variation.itemVariationData, serviceDuration: 1800000n } } }), false);
  assert.equal(isExactFacialMassageAddOnVariation({ itemName: "Facial Massage Add-On", variation: { itemVariationData: { ...variation.itemVariationData, priceMoney: { amount: 2500n, currency: "USD" } } } }), false);
});

test("MassageBook Angela service maps to a dedicated two-segment add-on migration", () => {
  const mapping = mapMassageBookService("90 MIN CUSTOMIZED MASSAGE + 15 MIN FACIAL MASSAGE ADD-ON");
  assert.equal(mapping.serviceKey, "customized_90");
  assert.equal(mapping.manual.addOnKey, "facial_massage_15");
  assert.equal(mapping.manual.occupiedDurationMinutes, 105);
});
