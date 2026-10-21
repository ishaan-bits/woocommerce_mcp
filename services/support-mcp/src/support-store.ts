export type TicketStatus = "open" | "pending" | "resolved";
export type TicketPriority = "low" | "normal" | "high";

export const TICKET_STATUSES: readonly TicketStatus[] = ["open", "pending", "resolved"];
export const TICKET_PRIORITIES: readonly TicketPriority[] = ["low", "normal", "high"];

export interface Ticket {
  readonly id: number;
  readonly customer: string;
  readonly subject: string;
  readonly status: TicketStatus;
  readonly priority: TicketPriority;
  readonly created_at: string;
  readonly updated_at: string;
  readonly messages: number;
}

export interface TicketPage {
  readonly items: Ticket[];
  readonly total: number;
}

export interface CreateTicketInput {
  readonly customer: string;
  readonly subject: string;
  readonly priority?: TicketPriority | undefined;
}

/**
 * The seam between tool handlers and ticket data. Production uses the seeded
 * in-process store below; tests inject failing stores to exercise the
 * unavailable-data path without any real helpdesk system.
 */
export interface SupportDataSource {
  listTickets(filter: { status?: TicketStatus | undefined }, page: number, perPage: number): TicketPage;
  createTicket(input: CreateTicketInput): Ticket;
}

/**
 * Deterministic seed — 8 tickets, fixed ids/dates/statuses, no randomness.
 * Demo data only: no real helpdesk, CRM or ticketing system is connected.
 */
export const SEED_TICKETS: readonly Ticket[] = [
  {
    id: 1001,
    customer: "northwind-traders",
    subject: "Order 512 has not arrived",
    status: "open",
    priority: "high",
    created_at: "2026-09-30T09:15:00.000Z",
    updated_at: "2026-09-30T09:15:00.000Z",
    messages: 2,
  },
  {
    id: 1002,
    customer: "brightleaf-co",
    subject: "Request a VAT invoice for order 530",
    status: "pending",
    priority: "normal",
    created_at: "2026-10-01T14:02:00.000Z",
    updated_at: "2026-10-02T08:40:00.000Z",
    messages: 1,
  },
  {
    id: 1003,
    customer: "harbor-goods",
    subject: "Damaged mug in shipment",
    status: "resolved",
    priority: "high",
    created_at: "2026-10-02T11:30:00.000Z",
    updated_at: "2026-10-04T16:12:00.000Z",
    messages: 4,
  },
  {
    id: 1004,
    customer: "northwind-traders",
    subject: "Change delivery address for future orders",
    status: "open",
    priority: "normal",
    created_at: "2026-10-03T10:05:00.000Z",
    updated_at: "2026-10-03T10:05:00.000Z",
    messages: 1,
  },
  {
    id: 1005,
    customer: "cedar-and-sons",
    subject: "Subscription renewal question",
    status: "pending",
    priority: "low",
    created_at: "2026-10-05T13:44:00.000Z",
    updated_at: "2026-10-06T09:21:00.000Z",
    messages: 2,
  },
  {
    id: 1006,
    customer: "brightleaf-co",
    subject: "Wholesale pricing for canvas totes",
    status: "open",
    priority: "normal",
    created_at: "2026-10-07T15:18:00.000Z",
    updated_at: "2026-10-08T11:03:00.000Z",
    messages: 3,
  },
  {
    id: 1007,
    customer: "harbor-goods",
    subject: "Refund for order 498",
    status: "resolved",
    priority: "normal",
    created_at: "2026-10-09T08:55:00.000Z",
    updated_at: "2026-10-11T17:30:00.000Z",
    messages: 5,
  },
  {
    id: 1008,
    customer: "cedar-and-sons",
    subject: "Where is my tracking number?",
    status: "open",
    priority: "high",
    created_at: "2026-10-12T12:10:00.000Z",
    updated_at: "2026-10-12T12:10:00.000Z",
    messages: 1,
  },
] as const;

export const SEEDED_TICKET_COUNT = SEED_TICKETS.length;
export const FIRST_CREATED_TICKET_ID = 1009;

export interface CreateSupportStoreOptions {
  /** Injectable clock so created_at/updated_at are deterministic in tests. */
  now?: () => number;
}

export function createSupportStore(options: CreateSupportStoreOptions = {}): SupportDataSource {
  const now = options.now ?? Date.now;
  const tickets: Ticket[] = SEED_TICKETS.map((ticket) => ({ ...ticket }));
  let nextId = FIRST_CREATED_TICKET_ID;

  return {
    listTickets(filter, page, perPage) {
      const filtered = filter.status !== undefined ? tickets.filter((t) => t.status === filter.status) : tickets;
      const total = filtered.length;
      const start = (page - 1) * perPage;
      const items = filtered.slice(start, start + perPage).map((ticket) => ({ ...ticket }));
      return { items, total };
    },

    createTicket(input) {
      const timestamp = new Date(now()).toISOString();
      const ticket: Ticket = {
        id: nextId,
        customer: input.customer.trim(),
        subject: input.subject.trim(),
        status: "open",
        priority: input.priority ?? "normal",
        created_at: timestamp,
        updated_at: timestamp,
        messages: 1,
      };
      nextId += 1;
      tickets.push(ticket);
      return { ...ticket };
    },
  };
}
