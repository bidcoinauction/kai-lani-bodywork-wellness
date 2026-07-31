export const SQUARE_LOCATION_ID = process.env.SQUARE_LOCATION_ID || "";
export const SQUARE_TEAM_MEMBER_ID = process.env.SQUARE_TEAM_MEMBER_ID || "";

export const KAI_LANI_SERVICES = {
  "customized-60": {
    id: "customized-60",
    name: "60 Min Customized Massage",
    durationMinutes: 60,
    price: 93,
  },
  "deep-tissue-60": {
    id: "deep-tissue-60",
    name: "60 Min Customized Deep Tissue Massage",
    durationMinutes: 60,
    price: 93,
  },
  "prenatal-60": {
    id: "prenatal-60",
    name: "60 Min Customized Prenatal Massage",
    durationMinutes: 60,
    price: 97,
  },
  "customized-90": {
    id: "customized-90",
    name: "90 Min Customized Massage",
    durationMinutes: 90,
    price: 123,
  },
  "deep-tissue-90": {
    id: "deep-tissue-90",
    name: "90 Min Customized Deep Tissue Massage",
    durationMinutes: 90,
    price: 123,
  },
};

export const SERVICE_IDS = Object.keys(KAI_LANI_SERVICES);
