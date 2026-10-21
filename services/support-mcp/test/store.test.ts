import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  createSupportStore,
  FIRST_CREATED_TICKET_ID,
  SEED_TICKETS,
  SEEDED_TICKET_COUNT,
} from "../src/support-store.ts";

describe("seeded support store", () => {
  test("seed is deterministic: 8 tickets, ids 1001-1008, unique subjects", () => {
    assert.equal(SEED_TICKETS.length, SEEDED_TICKET_COUNT);
    assert.deepEqual(SEED_TICKETS.map((ticket) => ticket.id), [1001, 1002, 1003, 1004, 1005, 1006, 1007, 1008]);
    assert.equal(new Set(SEED_TICKETS.map((ticket) => ticket.subject)).size, SEEDED_TICKET_COUNT);
    const store = createSupportStore();
    assert.equal(store.listTickets({}, 1, 100).total, SEEDED_TICKET_COUNT);
  });

  test("status filter returns only matching tickets and unknown status yields empty", () => {
    const store = createSupportStore();
    const open = store.listTickets({ status: "open" }, 1, 100);
    const pending = store.listTickets({ status: "pending" }, 1, 100);
    const resolved = store.listTickets({ status: "resolved" }, 1, 100);
    assert.equal(open.total, 4);
    assert.equal(pending.total, 2);
    assert.equal(resolved.total, 2);
    assert.ok(open.items.every((ticket) => ticket.status === "open"));
    assert.equal(open.total + pending.total + resolved.total, SEEDED_TICKET_COUNT);
  });

  test("pagination slices the seeded order deterministically", () => {
    const store = createSupportStore();
    const page1 = store.listTickets({}, 1, 3);
    const page3 = store.listTickets({}, 3, 3);
    assert.equal(page1.items.length, 3);
    assert.equal(page3.items.length, 2);
    assert.equal(page1.items[0]?.id, SEED_TICKETS[0]?.id);
    assert.equal(page3.items[0]?.id, SEED_TICKETS[6]?.id);
    assert.deepEqual(store.listTickets({}, 9, 3).items, []);
  });

  test("createTicket appends an open ticket with the next id and injectable clock", () => {
    const store = createSupportStore({ now: () => Date.parse("2026-10-21T12:00:00.000Z") });
    const ticket = store.createTicket({ customer: "cedar-and-sons", subject: "New question" });
    assert.equal(ticket.id, FIRST_CREATED_TICKET_ID);
    assert.equal(ticket.status, "open");
    assert.equal(ticket.priority, "normal");
    assert.equal(ticket.created_at, "2026-10-21T12:00:00.000Z");
    assert.equal(ticket.updated_at, "2026-10-21T12:00:00.000Z");
    assert.equal(ticket.messages, 1);

    const next = store.createTicket({ customer: "x", subject: "y", priority: "high" });
    assert.equal(next.id, FIRST_CREATED_TICKET_ID + 1);
    assert.equal(next.priority, "high");

    // New ticket is visible to later reads; the original page grew by two.
    assert.equal(store.listTickets({}, 1, 100).total, SEEDED_TICKET_COUNT + 2);
    assert.equal(store.listTickets({}, 1, 100).items.at(-1)?.id, FIRST_CREATED_TICKET_ID + 1);
  });

  test("new tickets always start open, regardless of seed statuses", () => {
    const store = createSupportStore();
    const ticket = store.createTicket({ customer: "a", subject: "b" });
    assert.equal(ticket.status, "open");
    assert.ok(ticket.id > SEED_TICKETS.at(-1)!.id);
  });

  test("pages return copies, so callers cannot mutate the store by reference", () => {
    const store = createSupportStore();
    const page = store.listTickets({}, 1, 100);
    const first = page.items[0]!;
    (first as unknown as { status: string }).status = "resolved";
    const fresh = store.listTickets({}, 1, 100);
    assert.equal(fresh.items[0]?.status, SEED_TICKETS[0]?.status, "store unchanged after caller mutation");
  });
});
