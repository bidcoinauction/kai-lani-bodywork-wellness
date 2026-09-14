export const SQUARE_ADD_ONS = Object.freeze({
  facial_massage_15: {
    key: "facial_massage_15",
    itemName: "Facial Massage Add-On",
    variationName: "15 MIN FACIAL MASSAGE ADD-ON",
    durationMinutes: 15,
    price: 30,
    priceCents: 3000,
    currency: "USD",
  },
});

export function getAddOnConfig(addOnKey) {
  return SQUARE_ADD_ONS[addOnKey] || null;
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
