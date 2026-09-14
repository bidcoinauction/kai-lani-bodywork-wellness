export const SQUARE_ADD_ONS = Object.freeze({
  facial_massage_15: {
    key: "facial_massage_15",
    publicKey: "facial-massage",
    name: "Facial Massage",
    itemName: "Facial Massage Add-On",
    variationName: "15 MIN FACIAL MASSAGE ADD-ON",
    durationMinutes: 15,
    price: 30,
    priceCents: 3000,
    currency: "USD",
    variationIdEnv: "SQUARE_ADDON_FACIAL_MASSAGE_15_ID",
  },
});

export function getAddOnConfig(addOnKey) {
  const addOn = SQUARE_ADD_ONS[addOnKey];
  if (!addOn) return null;
  return {
    ...addOn,
    serviceVariationId: process.env[addOn.variationIdEnv] || null,
  };
}

export function normalizeAddOnKeys(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) return null;
  const seen = new Set();
  const keys = [];
  for (const raw of value) {
    if (raw !== "facial-massage" && raw !== "facial_massage_15") return null;
    const key = "facial_massage_15";
    if (!seen.has(key)) {
      seen.add(key);
      keys.push(key);
    }
  }
  return keys;
}

export function addOnsForKeys(keys = []) {
  return keys.map(getAddOnConfig).filter(Boolean);
}

export function addOnsDurationMinutes(keys = []) {
  return addOnsForKeys(keys).reduce((total, addOn) => total + addOn.durationMinutes, 0);
}

export function addOnsPriceCents(keys = []) {
  return addOnsForKeys(keys).reduce((total, addOn) => total + addOn.priceCents, 0);
}

export function isExactFacialMassageAddOnVariation({ itemName, variation }) {
  const addOn = SQUARE_ADD_ONS.facial_massage_15;
  const data = variation?.itemVariationData || {};
  const durationMinutes = data.serviceDuration == null ? null : Math.round(Number(data.serviceDuration) / 60000);
  const priceCents = data.priceMoney?.amount == null ? null : Number(data.priceMoney.amount);
  return itemName === addOn.itemName &&
    data.name === addOn.variationName &&
    durationMinutes === addOn.durationMinutes &&
    priceCents === addOn.priceCents &&
    data.priceMoney?.currency === addOn.currency;
}
