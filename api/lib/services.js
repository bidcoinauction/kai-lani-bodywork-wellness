export const SQUARE_SERVICES = {
  customized_60: {
    key: "customized_60",
    name: "60 Min Customized Massage",
    durationMinutes: 60,
    price: 93,
    variationIdEnv: "SQUARE_SERVICE_CUSTOMIZED_60_ID",
  },
  deep_tissue_60: {
    key: "deep_tissue_60",
    name: "60 Min Customized Deep Tissue Massage",
    durationMinutes: 60,
    price: 93,
    variationIdEnv: "SQUARE_SERVICE_DEEP_TISSUE_60_ID",
  },
  prenatal_60: {
    key: "prenatal_60",
    name: "60 Min Customized Prenatal Massage",
    durationMinutes: 60,
    price: 97,
    variationIdEnv: "SQUARE_SERVICE_PRENATAL_60_ID",
  },
  customized_90: {
    key: "customized_90",
    name: "90 Min Customized Massage",
    durationMinutes: 90,
    price: 123,
    variationIdEnv: "SQUARE_SERVICE_CUSTOMIZED_90_ID",
  },
  deep_tissue_90: {
    key: "deep_tissue_90",
    name: "90 Min Customized Deep Tissue Massage",
    durationMinutes: 90,
    price: 123,
    variationIdEnv: "SQUARE_SERVICE_DEEP_TISSUE_90_ID",
  },
};

export const SERVICE_KEYS = Object.keys(SQUARE_SERVICES);

export function isServiceKey(value) {
  return Object.prototype.hasOwnProperty.call(SQUARE_SERVICES, value);
}

export function getServiceConfig(serviceKey) {
  if (!isServiceKey(serviceKey)) return null;
  const service = SQUARE_SERVICES[serviceKey];
  return {
    key: service.key,
    name: service.name,
    durationMinutes: service.durationMinutes,
    price: service.price,
    variationIdEnv: service.variationIdEnv,
    serviceVariationId: process.env[service.variationIdEnv] || null,
  };
}
