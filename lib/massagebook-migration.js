import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, extname, resolve } from "node:path";
import { getSquareClient } from "./square.js";
import { requireBookingConfig } from "./config.js";
import { getServiceConfig } from "./services.js";
import {
  TURNOVER_BUFFER_MINUTES,
  formatSquarePhoneE164,
  hasTurnoverConflict,
  listSquareBlockingBookings,
} from "./booking-requests.js";
import { addDays, addMinutes, getNewYorkDateString, startOfDayInTimeZone } from "./time.js";

export const FUTURE_APPOINTMENTS_SHEET = "Future Appointments";
export const EXPECTED_APPOINTMENT_ROWS = 58;
const require = createRequire(import.meta.url);

export const MASSAGEBOOK_SERVICE_MAPPING = Object.freeze({
  "60 MIN CUSTOMIZED MASSAGE": "customized_60",
  "60 MIN CUSTOMIZED DEEP TISSUE MASSAGE": "deep_tissue_60",
  "90 MIN CUSTOMIZED MASSAGE": "customized_90",
  "90 MIN CUSTOMIZED DEEP TISSUE MASSAGE": "deep_tissue_90",
});

export const MANUAL_SERVICE_MAPPINGS = Object.freeze({
  "90 MIN CUSTOMIZED MASSAGE + 15 MIN FACIAL MASSAGE ADD-ON": {
    status: "MANUAL_MIGRATION_REQUIRED",
    primaryServiceKey: "customized_90",
    addOnKey: "facial_massage_15",
    occupiedDurationMinutes: 105,
    reason: "legacy_two_segment_add_on_requires_dedicated_migration",
  },
});

const REQUIRED_COLUMNS = ["date", "time", "client", "email", "mobile", "service"];
const HEADER_ALIASES = new Map([
  ["date", "date"],
  ["time", "time"],
  ["client", "client"],
  ["email", "email"],
  ["mobile", "mobile"],
  ["service / duration", "service"],
  ["service", "service"],
  ["notes", "notes"],
]);

function clean(value) {
  if (value == null) return "";
  return String(value).replace(/\s+/g, " ").trim();
}

function normalizeHeader(value) {
  return clean(value).toLowerCase();
}

function excelDateToDateString(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return getNewYorkDateString(value);
  }
  if (typeof value === "number") {
    const epoch = Date.UTC(1899, 11, 30);
    return new Date(epoch + Math.round(value) * 86400000).toISOString().slice(0, 10);
  }
  const text = clean(value);
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  const parsed = new Date(text);
  if (!Number.isNaN(parsed.getTime())) return getNewYorkDateString(parsed);
  return text;
}

function excelTimeToTimeString(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return `${String(value.getUTCHours()).padStart(2, "0")}:${String(value.getUTCMinutes()).padStart(2, "0")}`;
  }
  if (typeof value === "number") {
    const totalMinutes = Math.round(value * 24 * 60) % (24 * 60);
    return `${String(Math.floor(totalMinutes / 60)).padStart(2, "0")}:${String(totalMinutes % 60).padStart(2, "0")}`;
  }
  const text = clean(value);
  const match24 = text.match(/^(\d{1,2}):(\d{2})$/);
  if (match24) return `${String(Number(match24[1])).padStart(2, "0")}:${match24[2]}`;
  const match12 = text.match(/^(\d{1,2})(?::(\d{2}))?\s*([AP]M)$/i);
  if (match12) {
    let hour = Number(match12[1]) % 12;
    if (match12[3].toUpperCase() === "PM") hour += 12;
    return `${String(hour).padStart(2, "0")}:${match12[2] || "00"}`;
  }
  return text;
}

export function startAtFromDateTime(date, time) {
  const [hours, minutes] = time.split(":").map(Number);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isInteger(hours) || !Number.isInteger(minutes)) {
    return null;
  }
  return addMinutes(startOfDayInTimeZone(date), hours * 60 + minutes).toISOString();
}

function findHeader(rows) {
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const columns = new Map();
    rows[rowIndex].forEach((cell, index) => {
      const canonical = HEADER_ALIASES.get(normalizeHeader(cell));
      if (canonical && !columns.has(canonical)) columns.set(canonical, index);
    });
    if (REQUIRED_COLUMNS.every((name) => columns.has(name))) {
      return { rowIndex, columns };
    }
  }
  return null;
}

export function normalizeWorkbookRows(rows) {
  const header = findHeader(rows);
  if (!header) throw new Error("future_appointments_header_missing");
  const normalized = [];
  for (const row of rows.slice(header.rowIndex + 1)) {
    const get = (name) => row[header.columns.get(name)];
    const raw = {
      date: excelDateToDateString(get("date")),
      time: excelTimeToTimeString(get("time")),
      client_name: clean(get("client")),
      email: clean(get("email")).toLowerCase(),
      mobile: clean(get("mobile")),
      service: clean(get("service")).toUpperCase(),
      notes: clean(get("notes")),
    };
    if (Object.values(raw).some(Boolean)) normalized.push(raw);
  }
  return normalized;
}

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (char !== "\r") {
      cell += char;
    }
  }
  row.push(cell);
  if (row.some((value) => value !== "")) rows.push(row);
  return rows;
}

export function loadAppointments(inputPath) {
  const path = resolve(inputPath);
  if (!existsSync(path)) throw new Error(`input_not_found:${path}`);
  const extension = extname(path).toLowerCase();
  if (extension === ".xlsx") {
    const xlsx = require("xlsx");
    const workbook = xlsx.readFile(path, { cellDates: true });
    const sheet = workbook.Sheets[FUTURE_APPOINTMENTS_SHEET];
    if (!sheet) throw new Error(`worksheet_not_found:${FUTURE_APPOINTMENTS_SHEET}`);
    const rows = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: "" });
    return { rows: normalizeWorkbookRows(rows), workbookFound: true, worksheetFound: true };
  }
  if (extension === ".csv") {
    return { rows: normalizeWorkbookRows(parseCsv(readFileSync(path, "utf8"))), workbookFound: true, worksheetFound: true };
  }
  throw new Error(`unsupported_input:${extension}`);
}

export function validateAppointments(rows, expectedRows = EXPECTED_APPOINTMENT_ROWS) {
  const invalid = [];
  const serviceCounts = {};
  rows.forEach((row, index) => {
    const rowNumber = index + 1;
    if (!row.date) invalid.push({ rowNumber, field: "date", reason: "blank" });
    if (!row.time) invalid.push({ rowNumber, field: "time", reason: "blank" });
    if (!row.client_name) invalid.push({ rowNumber, field: "client", reason: "blank" });
    if (!row.email) invalid.push({ rowNumber, field: "email", reason: "blank" });
    if (!row.mobile) invalid.push({ rowNumber, field: "mobile", reason: "blank" });
    if (!row.service) invalid.push({ rowNumber, field: "service", reason: "blank" });
    for (const [field, value] of Object.entries(row)) {
      if (/\b(VERIFY|UNKNOWN)\b/i.test(value)) invalid.push({ rowNumber, field, reason: "verify_or_unknown" });
    }
    serviceCounts[row.service] = (serviceCounts[row.service] || 0) + 1;
  });
  if (rows.length !== expectedRows) invalid.push({ rowNumber: null, field: "rows", reason: `expected_${expectedRows}_got_${rows.length}` });
  return { valid: invalid.length === 0, invalid, serviceCounts };
}

export function mapMassageBookService(label) {
  const normalized = clean(label).toUpperCase();
  const manual = MANUAL_SERVICE_MAPPINGS[normalized];
  if (manual) return { serviceKey: manual.primaryServiceKey, status: manual.status, manual };
  const serviceKey = MASSAGEBOOK_SERVICE_MAPPING[normalized] || null;
  if (!serviceKey) return { serviceKey: null, status: "UNMAPPED" };
  const service = getServiceConfig(serviceKey);
  return { serviceKey, status: service ? "MAPPED" : "CONFIG_MISSING", service };
}

export function splitClientName(name) {
  const parts = clean(name).split(" ").filter(Boolean);
  if (parts.length === 0) return { firstName: "", lastName: "" };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") || parts[0] };
}

function normalizedDigits(value) {
  return clean(value).replace(/\D/g, "");
}

function namesMatch(customer, row) {
  const full = `${customer?.givenName || customer?.given_name || ""} ${customer?.familyName || customer?.family_name || ""}`.replace(/\s+/g, " ").trim().toLowerCase();
  return full && full === row.client_name.toLowerCase();
}

function customerSuffix(customer) {
  const id = customer?.id || "";
  return id ? `...${id.slice(-6)}` : null;
}

async function searchCustomers(client, row) {
  const squarePhone = formatSquarePhoneE164(row.mobile);
  const [emailResult, phoneResult] = await Promise.all([
    row.email ? client.customers.search({ query: { filter: { emailAddress: { exact: row.email } } } }) : { customers: [] },
    squarePhone ? client.customers.search({ query: { filter: { phoneNumber: { exact: squarePhone } } } }) : { customers: [] },
  ]);
  return {
    emailMatches: emailResult.customers || [],
    phoneMatches: phoneResult.customers || [],
    squarePhone,
  };
}

export async function reconcileCustomerReadOnly(client, row) {
  const { emailMatches, phoneMatches, squarePhone } = await searchCustomers(client, row);
  if (row.client_name.toLowerCase() === "joshua castle" && emailMatches.some((customer) => !namesMatch(customer, row))) {
    return { classification: "AMBIGUOUS_CUSTOMER", customer: null, reason: "shared_email_name_mismatch" };
  }
  if (emailMatches.length > 1 || phoneMatches.length > 1) {
    return { classification: "AMBIGUOUS_CUSTOMER", customer: null, reason: "multiple_square_matches" };
  }
  const emailCustomer = emailMatches[0] || null;
  const phoneCustomer = phoneMatches[0] || null;
  if (emailCustomer && phoneCustomer && emailCustomer.id !== phoneCustomer.id) {
    return { classification: "DATA_CONFLICT", customer: null, reason: "email_phone_different_customers" };
  }
  const customer = emailCustomer || phoneCustomer;
  if (!customer) return { classification: "WOULD_CREATE_NEW_CUSTOMER", customer: null, reason: squarePhone ? "no_match" : "invalid_phone" };
  if (emailCustomer && phoneCustomer && namesMatch(customer, row)) {
    return { classification: "EXACT_EXISTING_CUSTOMER", customer, reason: "email_phone_name_match" };
  }
  if (phoneCustomer && !emailCustomer) return { classification: "UNIQUE_PHONE_MATCH", customer, reason: namesMatch(customer, row) ? "phone_name_match" : "phone_only" };
  if (emailCustomer && !phoneCustomer) {
    if (!namesMatch(customer, row)) return { classification: "AMBIGUOUS_CUSTOMER", customer: null, reason: "email_name_mismatch" };
    return { classification: "UNIQUE_EMAIL_MATCH", customer, reason: "email_name_match" };
  }
  return { classification: "EXACT_EXISTING_CUSTOMER", customer, reason: "email_phone_match" };
}

function bookingDuration(booking) {
  return Number(booking?.appointmentSegments?.[0]?.durationMinutes || booking?.durationMinutes || 0);
}

function bookingServiceVariation(booking) {
  return booking?.appointmentSegments?.[0]?.serviceVariationId || null;
}

function bookingTeamMember(booking) {
  return booking?.appointmentSegments?.[0]?.teamMemberId || null;
}

export function classifyExistingBooking(row, config, customer, bookings) {
  const startAt = startAtFromDateTime(row.date, row.time);
  const active = bookings.filter((booking) => !["CANCELLED_BY_CUSTOMER", "CANCELLED_BY_SELLER", "DECLINED", "NO_SHOW"].includes(booking.status));
  const sameStart = active.filter((booking) => new Date(booking.startAt).getTime() === new Date(startAt).getTime());
  const exact = sameStart.find((booking) =>
    booking.customerId === customer?.id &&
    booking.locationId === config.locationId &&
    bookingServiceVariation(booking) === config.service.serviceVariationId &&
    bookingDuration(booking) === config.service.durationMinutes &&
    bookingTeamMember(booking) === config.teamMemberId
  );
  if (exact) return { classification: "EXACT_BOOKING_ALREADY_EXISTS", booking: exact };
  if (sameStart.some((booking) => booking.customerId && customer?.id && booking.customerId !== customer.id)) return { classification: "CUSTOMER_CONFLICT", booking: sameStart[0] };
  if (sameStart.some((booking) => bookingServiceVariation(booking) !== config.service.serviceVariationId || bookingDuration(booking) !== config.service.durationMinutes)) return { classification: "SERVICE_CONFLICT", booking: sameStart[0] };
  if (hasTurnoverConflict({ startAt, durationMinutes: config.service.durationMinutes, existing: active })) return { classification: "TIME_CONFLICT", booking: active[0] };
  return { classification: "NO_EXISTING_BOOKING", booking: null };
}

async function listDayBookings(client, config, row) {
  const dayStart = startOfDayInTimeZone(row.date);
  return listSquareBlockingBookings(client, {
    locationId: config.locationId,
    teamMemberId: config.teamMemberId,
    dayStart,
    dayEnd: addDays(dayStart, 1),
  });
}

export function compareMigratedRowsForBuffer(rows) {
  const conflicts = [];
  const prepared = rows.map((row, index) => {
    const mapping = mapMassageBookService(row.service);
    const service = itemService(mapping);
    return { row, index, mapping, service, startAt: startAtFromDateTime(row.date, row.time) };
  }).filter((item) => item.service && item.startAt);
  for (let i = 0; i < prepared.length; i += 1) {
    for (let j = i + 1; j < prepared.length; j += 1) {
      const a = prepared[i];
      const b = prepared[j];
      if (a.row.date !== b.row.date) continue;
      if (hasTurnoverConflict({ startAt: a.startAt, durationMinutes: a.service.durationMinutes, existing: [{ startAt: b.startAt, durationMinutes: b.service.durationMinutes }] })) {
        conflicts.push({ rows: [a.index + 1, b.index + 1], classification: "LEGACY_BUFFER_EXCEPTION_ACCEPTED" });
      }
    }
  }
  return conflicts;
}

function itemService(mapping) {
  if (mapping.service) return mapping.service;
  if (mapping.manual?.occupiedDurationMinutes) {
    const primary = getServiceConfig(mapping.manual.primaryServiceKey);
    return primary ? { ...primary, durationMinutes: mapping.manual.occupiedDurationMinutes } : null;
  }
  return null;
}

function blankReportSummary(loaded, validation, migrationConflicts) {
  return {
    workbookFound: loaded.workbookFound,
    worksheetFound: loaded.worksheetFound,
    actualRows: loaded.rows.length,
    uniqueClients: new Set(loaded.rows.map((row) => `${row.client_name}|${row.email}|${row.mobile}`)).size,
    firstAppointment: loaded.rows[0] || null,
    lastAppointment: loaded.rows.at(-1) || null,
    serviceCounts: validation.serviceCounts,
    validationErrors: validation.invalid,
    customerCounts: {},
    bookingCounts: {},
    serviceMappingConflicts: 0,
    manualMigrationRows: 0,
    legacyBufferExceptions: migrationConflicts.length,
    dryRunSquareWrites: 0,
    dryRunNeonWrites: 0,
    squareCustomerWrites: 0,
    squareBookingWrites: 0,
    squareOrderWrites: 0,
    squarePaymentWrites: 0,
    emailsSent: 0,
    applicationEmailsDuringExecute: 0,
    squareNotificationsExpectedDuringExecute: "Square CreateBooking notification behavior depends on Square buyer-level booking settings; migration code does not call Kai Lani email helpers.",
    squareReadOnlyStatus: "not_started",
    squareReadOnlyError: null,
  };
}

export async function buildMigrationDryRun({ input, client = null, expectedRows = EXPECTED_APPOINTMENT_ROWS } = {}) {
  const loaded = loadAppointments(input);
  return buildMigrationDryRunFromRows({ loaded, client, expectedRows });
}

export async function buildMigrationDryRunFromRows({ rows, loaded, client = null, expectedRows = EXPECTED_APPOINTMENT_ROWS } = {}) {
  loaded = loaded || { rows, workbookFound: true, worksheetFound: true };
  const validation = validateAppointments(loaded.rows, expectedRows);
  const migrationConflicts = compareMigratedRowsForBuffer(loaded.rows);
  let square = client;
  let squareReadOnlyError = null;
  if (!square) {
    try {
      square = getSquareClient();
    } catch (error) {
      squareReadOnlyError = error?.message || "square_client_unavailable";
    }
  }
  const reportRows = [];
  const summary = blankReportSummary(loaded, validation, migrationConflicts);
  summary.squareReadOnlyStatus = square ? "available" : "not_configured";
  summary.squareReadOnlyError = squareReadOnlyError ? "square_client_unavailable" : null;
  const customerCache = new Map();

  for (let index = 0; index < loaded.rows.length; index += 1) {
    const row = loaded.rows[index];
    const mapping = mapMassageBookService(row.service);
    if (mapping.status === "MANUAL_MIGRATION_REQUIRED") summary.manualMigrationRows += 1;
    else if (!mapping.serviceKey || mapping.status !== "MAPPED") summary.serviceMappingConflicts += 1;
    let config = null;
    try {
      config = mapping.serviceKey ? requireBookingConfig(mapping.serviceKey) : null;
    } catch {
      config = null;
    }
    const customerKey = `${row.client_name}|${row.email}|${row.mobile}`;
    let customer = customerCache.get(customerKey);
    if (!customer) {
      customer = square
        ? await reconcileCustomerReadOnly(square, row)
        : { classification: "NOT_CHECKED", customer: null, reason: "square_client_unavailable" };
      customerCache.set(customerKey, customer);
    }
    summary.customerCounts[customer.classification] = (summary.customerCounts[customer.classification] || 0) + 1;
    let booking = { classification: "NOT_CHECKED", booking: null };
    if (!square) {
      booking = { classification: "NOT_CHECKED", booking: null };
    } else if (config && customer.customer) {
      booking = classifyExistingBooking(row, config, customer.customer, await listDayBookings(square, config, row));
    } else if (config && customer.classification === "WOULD_CREATE_NEW_CUSTOMER") {
      booking = classifyExistingBooking(row, config, null, await listDayBookings(square, config, row));
    }
    summary.bookingCounts[booking.classification] = (summary.bookingCounts[booking.classification] || 0) + 1;
    const rowConflict = migrationConflicts.find((conflict) => conflict.rows.includes(index + 1));
    const manual = mapping.status === "MANUAL_MIGRATION_REQUIRED";
    const ready = validation.valid && mapping.status === "MAPPED" && ["EXACT_EXISTING_CUSTOMER", "UNIQUE_PHONE_MATCH", "UNIQUE_EMAIL_MATCH", "WOULD_CREATE_NEW_CUSTOMER"].includes(customer.classification) && booking.classification === "NO_EXISTING_BOOKING";
    reportRows.push({
      row: index + 1,
      date: row.date,
      time: row.time,
      startAt: startAtFromDateTime(row.date, row.time),
      client: row.client_name,
      service: row.service,
      serviceMapping: mapping.serviceKey,
      occupiedDurationMinutes: mapping.manual?.occupiedDurationMinutes || mapping.service?.durationMinutes || null,
      resolvedSquareCustomerSuffix: customerSuffix(customer.customer),
      customerAction: customer.classification,
      existingBookingStatus: booking.classification,
      resolvedSquareBookingSuffix: booking.booking?.id ? `...${booking.booking.id.slice(-6)}` : null,
      proposedBookingAction: manual ? "MANUAL_MIGRATION_REQUIRED" : booking.classification === "EXACT_BOOKING_ALREADY_EXISTS" ? "SKIP_EXISTING" : ready ? "WOULD_CREATE_BOOKING" : "BLOCKED",
      conflict: manual ? "MANUAL_MIGRATION_REQUIRED" : rowConflict?.classification || (mapping.status !== "MAPPED" ? "SERVICE_MAPPING_CONFLICT" : booking.classification.endsWith("CONFLICT") ? booking.classification : null),
      ready_to_migrate: ready,
      reason: manual ? mapping.manual.reason : ready ? (rowConflict?.classification || "ready") : customer.reason || booking.classification || mapping.status,
    });
  }
  return { summary, rows: reportRows };
}

export function writeDryRunReport(report, outputPath = "migration/massagebook-migration-dry-run.json") {
  const resolved = resolve(outputPath);
  mkdirSync(dirname(resolved), { recursive: true });
  writeFileSync(resolved, `${JSON.stringify(report, null, 2)}\n`);
  return resolved;
}

export function loadDotEnvFile(path = ".env.local") {
  const resolved = resolve(path);
  if (!existsSync(resolved)) return false;
  const text = readFileSync(resolved, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const index = trimmed.indexOf("=");
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] == null) process.env[key] = value;
  }
  return true;
}

export function defaultInputLabel(input) {
  return basename(input || "");
}
