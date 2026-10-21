import { z } from "zod";
import { TICKET_PRIORITIES, TICKET_STATUSES } from "./support-store.ts";

export const PAGE_MESSAGE = "page must be an integer of 1 or more";
export const PER_PAGE_MESSAGE = "per_page must be an integer between 1 and 100";
export const STATUS_MESSAGE = `status must be one of: ${TICKET_STATUSES.join(", ")}`;
export const PRIORITY_MESSAGE = `priority must be one of: ${TICKET_PRIORITIES.join(", ")}`;
export const CUSTOMER_MESSAGE = "customer must be a non-empty string of at most 120 characters";
export const SUBJECT_MESSAGE = "subject must be a non-empty string of at most 200 characters";

const pageSchema = z.coerce
  .number()
  .int(PAGE_MESSAGE)
  .min(1, PAGE_MESSAGE)
  .default(1)
  .describe("1-based page number (default 1)");

const perPageSchema = z.coerce
  .number()
  .int(PER_PAGE_MESSAGE)
  .min(1, PER_PAGE_MESSAGE)
  .max(100, PER_PAGE_MESSAGE)
  .default(10)
  .describe("Items per page, 1-100 (default 10)");

export const listTicketsInput = {
  page: pageSchema,
  per_page: perPageSchema,
  status: z
    .enum(TICKET_STATUSES, { error: STATUS_MESSAGE })
    .optional()
    .describe("Filter to a single status: open, pending or resolved (default: all)"),
};

export const createTicketInput = {
  customer: z
    .string({ error: CUSTOMER_MESSAGE })
    .trim()
    .min(1, CUSTOMER_MESSAGE)
    .max(120, CUSTOMER_MESSAGE)
    .describe("Customer identifier, e.g. northwind-traders"),
  subject: z
    .string({ error: SUBJECT_MESSAGE })
    .trim()
    .min(1, SUBJECT_MESSAGE)
    .max(200, SUBJECT_MESSAGE)
    .describe("Short ticket subject line (trimmed; 1-200 characters)"),
  priority: z
    .enum(TICKET_PRIORITIES, { error: PRIORITY_MESSAGE })
    .default("normal")
    .describe("Priority: low, normal (default) or high"),
};
