import { getServiceConfig, servicePriceCents } from "./services.js";

export const PAYMENT_CURRENCY = "USD";
export const BUSINESS_NAME = "Kai Lani Bodywork & Wellness";
export const BUSINESS_EMAIL = "kailanibodywork@gmail.com";
export const BRAND_COLOR = "#0a1f24";
export const PAYMENT_ALLOWED_STATUS = "approved";
export const PAYMENT_ALLOWED_SQUARE_STATUS = "ACCEPTED";

export function isPaymentEligible(row) {
  return Boolean(
    row &&
      row.status === PAYMENT_ALLOWED_STATUS &&
      row.squareBookingStatus === PAYMENT_ALLOWED_SQUARE_STATUS &&
      row.squareBookingId &&
      row.squareCustomerId &&
      !row.squareCanceledAt &&
      !["canceled", "no_show", "failed"].includes(row.squareSyncStatus),
  );
}

export function paymentAmountForService(serviceKey) {
  return servicePriceCents(serviceKey);
}

export function buildPaymentIdempotencyKey(requestId) {
  return `kai-lani.prepay.${requestId}`;
}

export function paymentPageUrl(requestKey, baseUrl = process.env.PUBLIC_SITE_URL) {
  if (!baseUrl || !requestKey) return null;
  const url = new URL("/payment", baseUrl);
  url.searchParams.set("requestKey", requestKey);
  return url.toString();
}

export function paymentCompleteUrl(requestKey, baseUrl = process.env.PUBLIC_SITE_URL) {
  if (!baseUrl || !requestKey) return null;
  const url = new URL("/payment/complete", baseUrl);
  url.searchParams.set("requestKey", requestKey);
  return url.toString();
}

export function isOrderPaid(order) {
  if (!order) return false;
  const state = String(order.state || "").toUpperCase();
  const due = order.netAmountDueMoney?.amount;
  const dueCents = typeof due === "bigint" ? Number(due) : Number(due ?? NaN);
  return state === "COMPLETED" || dueCents === 0;
}

export function buildPaymentLinkRequest(row) {
  const service = getServiceConfig(row.serviceKey);
  const amount = paymentAmountForService(row.serviceKey);
  if (!service || !amount) return null;

  const reference = row.requestKey || row.id;
  const safeNote = `${BUSINESS_NAME} ${service.name} appointment ${reference}`;
  return {
    idempotencyKey: buildPaymentIdempotencyKey(row.id),
    description: `${BUSINESS_NAME} optional prepayment ${reference}`,
    order: {
      locationId: row.squareLocationId || process.env.SQUARE_LOCATION_ID,
      customerId: row.squareCustomerId,
      referenceId: reference,
      source: { name: BUSINESS_NAME },
      lineItems: [
        {
          name: service.name,
          quantity: "1",
          basePriceMoney: {
            amount: BigInt(amount),
            currency: PAYMENT_CURRENCY,
          },
          note: `Confirmed appointment ${reference}`,
          metadata: {
            request_id: row.id,
            request_key: reference,
            square_booking_id: row.squareBookingId,
          },
        },
      ],
      metadata: {
        request_id: row.id,
        request_key: reference,
        square_booking_id: row.squareBookingId,
      },
    },
    checkoutOptions: {
      redirectUrl: paymentCompleteUrl(row.requestKey),
      merchantSupportEmail: BUSINESS_EMAIL,
      askForShippingAddress: false,
      allowTipping: false,
      enableCoupon: false,
      enableLoyalty: false,
    },
    prePopulatedData: {
      buyerEmail: row.email,
      buyerPhoneNumber: row.phone,
    },
    paymentNote: safeNote,
  };
}

export function summarizePayment(row, paid = false) {
  const service = getServiceConfig(row.serviceKey);
  const amount = paymentAmountForService(row.serviceKey);
  return {
    requestId: row.requestKey,
    requestKey: row.requestKey,
    status: row.status,
    squareBookingStatus: row.squareBookingStatus || null,
    serviceName: service?.name || row.serviceKey,
    amount,
    currency: PAYMENT_CURRENCY,
    paymentStatus: paid || row.paymentStatus === "paid" ? "paid" : row.paymentStatus || "not_started",
    paymentLinkUrl: paid || row.paymentStatus === "paid" ? null : row.paymentLinkUrl || null,
    paid: Boolean(paid || row.paymentStatus === "paid"),
  };
}
