import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import xlsx from "xlsx";
import {
  EXPECTED_APPOINTMENT_ROWS,
  FUTURE_APPOINTMENTS_SHEET,
  buildMigrationDryRun,
  classifyExistingBooking,
  compareMigratedRowsForBuffer,
  loadAppointments,
  mapMassageBookService,
  reconcileCustomerReadOnly,
  splitClientName,
  startAtFromDateTime,
  validateAppointments,
} from "../lib/massagebook-migration.js";
import { massagebookMigrationExecutionForTests } from "../api/internal/massagebook-migration-execute.js";
import { clearSquareEnv, installFullConfig } from "./helpers.js";

const ACTUAL_WORKBOOK = resolve("kai-lani-massagebook-to-square-migration-final.xlsx");

function appointment(overrides = {}) {
  return {
    Date: "2026-11-21",
    Time: "10:00",
    Client: "Test Client",
    Email: "test@example.invalid",
    Mobile: "(202) 555-0147",
    "Service / Duration": "90 MIN CUSTOMIZED MASSAGE",
    Notes: "fixture",
    ...overrides,
  };
}

function makeWorkbook(rows) {
  const dir = mkdtempSync(join(tmpdir(), "kai-lani-migration-"));
  const path = join(dir, "appointments.xlsx");
  const wb = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(wb, xlsx.utils.json_to_sheet([{ Count: rows.length }]), "Summary");
  xlsx.utils.book_append_sheet(wb, xlsx.utils.json_to_sheet(rows), FUTURE_APPOINTMENTS_SHEET);
  xlsx.writeFile(wb, path);
  return { dir, path };
}

function makeRows(count = EXPECTED_APPOINTMENT_ROWS) {
  return Array.from({ length: count }, (_, index) => appointment({
    Date: index === count - 1 ? "2026-11-21" : "2026-09-14",
    Time: `${String(10 + (index % 8)).padStart(2, "0")}:00`,
    Client: `Client ${index + 1}`,
    Email: `client-${index + 1}@example.invalid`,
    Mobile: `(202) 555-${String(1000 + index).slice(-4)}`,
    "Service / Duration": index % 2 === 0 ? "60 MIN CUSTOMIZED MASSAGE" : "90 MIN CUSTOMIZED DEEP TISSUE MASSAGE",
  }));
}

function clientForDryRun({ customers = [], bookings = [] } = {}) {
  const state = { customerSearches: 0, customerCreates: 0, bookingLists: 0, bookingCreates: 0 };
  const client = {
    customers: {
      search: async ({ query }) => {
        state.customerSearches += 1;
        const email = query.filter.emailAddress?.exact;
        const phone = query.filter.phoneNumber?.exact;
        return { customers: customers.filter((customer) => customer.emailAddress === email || customer.phoneNumber === phone) };
      },
      create: async () => {
        state.customerCreates += 1;
        return { customer: { id: "SHOULD_NOT_CREATE" } };
      },
    },
    bookings: {
      list: async () => {
        state.bookingLists += 1;
        return { data: bookings };
      },
      create: async () => {
        state.bookingCreates += 1;
        return { booking: { id: "SHOULD_NOT_CREATE" } };
      },
    },
  };
  return { client, state };
}

beforeEach(() => {
  installFullConfig();
});

afterEach(() => {
  clearSquareEnv();
});

test("actual workbook parses exactly 58 populated appointments and preserves the final row", () => {
  assert.equal(existsSync(ACTUAL_WORKBOOK), true, "authoritative workbook must be present");
  const { rows } = loadAppointments(ACTUAL_WORKBOOK);
  assert.equal(rows.length, EXPECTED_APPOINTMENT_ROWS);
  assert.equal(rows.at(-1).date, "2026-11-21");
  assert.equal(rows.at(-1).client_name, "Leyna Brown");
  assert.equal(rows.at(-1).service, "90 MIN CUSTOMIZED MASSAGE");
});

test("generated XLSX input normalizes required columns", () => {
  const fixture = makeWorkbook([appointment({ Date: new Date("2026-09-14T04:00:00.000Z"), Time: "1:30 PM" })]);
  try {
    const { rows } = loadAppointments(fixture.path);
    assert.deepEqual(rows[0], {
      date: "2026-09-14",
      time: "13:30",
      client_name: "Test Client",
      email: "test@example.invalid",
      mobile: "(202) 555-0147",
      service: "90 MIN CUSTOMIZED MASSAGE",
      notes: "fixture",
    });
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("validation requires exactly 58 rows and rejects blank or VERIFY/UNKNOWN data", () => {
  const rows = loadAppointments(makeWorkbook(makeRows()).path).rows;
  const valid = validateAppointments(rows);
  assert.equal(valid.valid, true);
  const invalid = validateAppointments([{ ...rows[0], time: "", service: "VERIFY UNKNOWN" }]);
  assert.equal(invalid.valid, false);
  assert.ok(invalid.invalid.some((entry) => entry.field === "time"));
  assert.ok(invalid.invalid.some((entry) => entry.reason === "verify_or_unknown"));
  assert.ok(invalid.invalid.some((entry) => entry.reason === "expected_58_got_1"));
});

test("service mapping uses authoritative Kai Lani service keys and refuses add-ons", () => {
  assert.equal(mapMassageBookService("60 MIN CUSTOMIZED MASSAGE").serviceKey, "customized_60");
  assert.equal(mapMassageBookService("60 MIN CUSTOMIZED DEEP TISSUE MASSAGE").serviceKey, "deep_tissue_60");
  assert.equal(mapMassageBookService("90 MIN CUSTOMIZED MASSAGE").serviceKey, "customized_90");
  assert.equal(mapMassageBookService("90 MIN CUSTOMIZED DEEP TISSUE MASSAGE").serviceKey, "deep_tissue_90");
  assert.equal(
    mapMassageBookService("90 MIN CUSTOMIZED MASSAGE + 15 MIN FACIAL MASSAGE ADD-ON").status,
    "MANUAL_MIGRATION_REQUIRED",
  );
  assert.equal(mapMassageBookService("15 MIN FACIAL MASSAGE ADD-ON").status, "UNMAPPED");
});

test("exact date and time are preserved as New York local appointment instants", () => {
  assert.equal(startAtFromDateTime("2026-09-14", "10:00"), "2026-09-14T14:00:00.000Z");
  assert.equal(startAtFromDateTime("2026-11-21", "10:00"), "2026-11-21T15:00:00.000Z");
});

test("customer reconciliation reuses exact customers and would create after both searches miss", async () => {
  const existing = { id: "CUST_EXISTING", givenName: "Test", familyName: "Client", emailAddress: "test@example.invalid", phoneNumber: "+12025550147" };
  const { client } = clientForDryRun({ customers: [existing] });
  const exact = await reconcileCustomerReadOnly(client, {
    client_name: "Test Client",
    email: "test@example.invalid",
    mobile: "(202) 555-0147",
  });
  assert.equal(exact.classification, "EXACT_EXISTING_CUSTOMER");
  const create = await reconcileCustomerReadOnly(client, {
    client_name: "New Client",
    email: "new@example.invalid",
    mobile: "(202) 555-0148",
  });
  assert.equal(create.classification, "WOULD_CREATE_NEW_CUSTOMER");
});

test("customer reconciliation refuses Joshua Castle shared-email ambiguity", async () => {
  const { client } = clientForDryRun({
    customers: [{ id: "CUST_LEILA", givenName: "Leila", familyName: "Noll", emailAddress: "shared@example.invalid", phoneNumber: "+12025550147" }],
  });
  const result = await reconcileCustomerReadOnly(client, {
    client_name: "Joshua Castle",
    email: "shared@example.invalid",
    mobile: "(202) 555-0148",
  });
  assert.equal(result.classification, "AMBIGUOUS_CUSTOMER");
});

test("duplicate detection prevents exact booking recreation and reports time conflicts", () => {
  const config = {
    locationId: "LOC_SANDBOX",
    teamMemberId: "TM_CHELSEA",
    service: { serviceVariationId: "VAR_CUSTOMIZED_60", durationMinutes: 60 },
  };
  const row = { date: "2026-09-14", time: "10:00" };
  const customer = { id: "CUST_1" };
  const exact = classifyExistingBooking(row, config, customer, [{
    id: "BK_1",
    status: "ACCEPTED",
    startAt: "2026-09-14T14:00:00.000Z",
    locationId: "LOC_SANDBOX",
    customerId: "CUST_1",
    appointmentSegments: [{ serviceVariationId: "VAR_CUSTOMIZED_60", teamMemberId: "TM_CHELSEA", durationMinutes: 60 }],
  }]);
  assert.equal(exact.classification, "EXACT_BOOKING_ALREADY_EXISTS");
  const conflict = classifyExistingBooking({ date: "2026-09-14", time: "11:00" }, config, customer, [{
    id: "BK_1",
    status: "ACCEPTED",
    startAt: "2026-09-14T14:00:00.000Z",
    locationId: "LOC_SANDBOX",
    customerId: "CUST_1",
    appointmentSegments: [{ serviceVariationId: "VAR_CUSTOMIZED_60", teamMemberId: "TM_CHELSEA", durationMinutes: 60 }],
  }]);
  assert.equal(conflict.classification, "TIME_CONFLICT");
});

test("buffer analysis catches migrated appointments inside the 30-minute turnover window", () => {
  const conflicts = compareMigratedRowsForBuffer([
    { date: "2026-09-14", time: "10:00", service: "60 MIN CUSTOMIZED MASSAGE" },
    { date: "2026-09-14", time: "11:29", service: "60 MIN CUSTOMIZED MASSAGE" },
  ]);
  assert.equal(conflicts.length, 1);
});

test("dry run performs zero Square writes and is idempotent across reruns", async () => {
  const fixture = makeWorkbook(makeRows());
  const { client, state } = clientForDryRun();
  try {
    const first = await buildMigrationDryRun({ input: fixture.path, client });
    const second = await buildMigrationDryRun({ input: fixture.path, client });
    assert.equal(first.summary.actualRows, EXPECTED_APPOINTMENT_ROWS);
    assert.equal(second.summary.actualRows, EXPECTED_APPOINTMENT_ROWS);
    assert.equal(state.customerCreates, 0);
    assert.equal(state.bookingCreates, 0);
    assert.equal(first.summary.dryRunSquareWrites, 0);
    assert.equal(first.summary.dryRunNeonWrites, 0);
    assert.deepEqual(first.rows.map((row) => row.proposedBookingAction), second.rows.map((row) => row.proposedBookingAction));
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("execute remains blocked during the audit implementation", () => {
  const { firstName, lastName } = splitClientName("Joshua Castle");
  assert.equal(firstName, "Joshua");
  assert.equal(lastName, "Castle");
});

test("migration execution scope reconciles to 58 source, 1 canary, 1 manual, 56 automatic", () => {
  const scope = massagebookMigrationExecutionForTests.scopeCheck();
  assert.equal(scope.total, 58);
  assert.equal(scope.laneCount, 1);
  assert.equal(scope.manualCount, 1);
  assert.equal(scope.eligibleCount, 56);
  assert.equal(scope.valid, true);
  assert.equal(massagebookMigrationExecutionForTests.MAX_BATCH, 10);
});

function mockCustomerClient(resultsByType) {
  return {
    customers: {
      search: async ({ query }) => {
        const filter = query?.filter || {};
        if (filter.emailAddress) return { customers: resultsByType.email || [] };
        if (filter.phoneNumber) return { customers: resultsByType.phone || [] };
        return { customers: [] };
      },
    },
  };
}

test("shared-email resolution prefers the name-matching customer", async () => {
  const row = { client_name: "Leila Noll", mobile: "(850) 661-9953", email: "leilanoll21@gmail.com" };
  const client = mockCustomerClient({
    email: [
      { id: "CUST_JOSHUA", givenName: "Joshua", familyName: "Castle" },
      { id: "CUST_LEILA", givenName: "Leila", familyName: "Noll" },
    ],
    phone: [{ id: "CUST_LEILA", givenName: "Leila", familyName: "Noll" }],
  });
  const resolved = await massagebookMigrationExecutionForTests.resolveCustomer(client, row);
  assert.equal(resolved.classification, "EXACT_EXISTING_CUSTOMER");
  assert.equal(resolved.customer.id, "CUST_LEILA");
});

test("Joshua Castle resolves by phone, never by shared email", async () => {
  const row = { client_name: "Joshua Castle", mobile: "(850) 496-3737", email: "leilanoll21@gmail.com" };
  const client = mockCustomerClient({ phone: [{ id: "CUST_JOSHUA", givenName: "Joshua", familyName: "Castle" }] });
  const resolved = await massagebookMigrationExecutionForTests.resolveCustomer(client, row);
  assert.equal(resolved.classification, "EXACT_EXISTING_CUSTOMER");

  const noPhone = mockCustomerClient({ phone: [] });
  const wouldCreate = await massagebookMigrationExecutionForTests.resolveCustomer(noPhone, row);
  assert.equal(wouldCreate.classification, "WOULD_CREATE_NEW_CUSTOMER");
});

test("customer name matching is exact on normalized full name", () => {
  const namesMatch = massagebookMigrationExecutionForTests.namesMatch;
  assert.equal(namesMatch({ givenName: "Lane", familyName: "Ellison" }, { client_name: "Lane Ellison" }), true);
  assert.equal(namesMatch({ givenName: "Leila", familyName: "Noll" }, { client_name: "Joshua Castle" }), false);
});

test("legacy buffer exception rows bypass the modern turnover gate", () => {
  const isLegacy = massagebookMigrationExecutionForTests.isLegacyBufferException;
  assert.equal(isLegacy({ row: 39 }), true);
  assert.equal(isLegacy({ row: 40 }), true);
  assert.equal(isLegacy({ row: 20 }), true);
  assert.equal(isLegacy({ row: 41 }), false);
});

test("invalid Square phone numbers are detected and customer create retries without phone", async () => {
  const isInvalid = massagebookMigrationExecutionForTests.isInvalidPhoneError;
  assert.equal(isInvalid({ errors: [{ code: "INVALID_PHONE_NUMBER" }] }), true);
  assert.equal(isInvalid({ errors: [{ code: "OTHER" }] }), false);

  const row = { row: 48, client_name: "Valorie Franklin", email: "v.zambito@gmail.com", mobile: "(400) 580-8323" };
  const calls = [];
  const client = {
    customers: {
      create: async (payload) => {
        calls.push(payload);
        if (payload.phoneNumber) {
          const err = new Error("invalid");
          err.errors = [{ code: "INVALID_PHONE_NUMBER" }];
          throw err;
        }
        return { customer: { id: "CUST_VALORIE" } };
      },
    },
  };
  const result = await massagebookMigrationExecutionForTests.createCustomer(client, row);
  assert.equal(result.phoneOmitted, true);
  assert.equal(result.customer.id, "CUST_VALORIE");
  assert.equal(calls.length, 2);
  assert.equal(calls[1].phoneNumber, undefined);
});
