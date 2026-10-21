import type { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Logger } from "./logger.ts";
import type { SupportDataSource } from "./support-store.ts";
import { createTicketInput, listTicketsInput } from "./tool-schemas.ts";

export type ListTicketsArgs = z.infer<z.ZodObject<typeof listTicketsInput>>;
export type CreateTicketArgs = z.infer<z.ZodObject<typeof createTicketInput>>;

export const LIST_UNAVAILABLE_MESSAGE =
  "The support data source is unavailable. See the server logs for details.";
export const CREATE_UNAVAILABLE_MESSAGE =
  "The support data source is unavailable. No ticket was created. See the server logs for details.";

export interface ToolHandlers {
  listTickets(args: ListTicketsArgs): Promise<CallToolResult>;
  createTicket(args: CreateTicketArgs): Promise<CallToolResult>;
}

function textResult(payload: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function errorResult(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

export function createToolHandlers(store: SupportDataSource, logger: Logger): ToolHandlers {
  function fail(tool: string, fallback: string, error: unknown): CallToolResult {
    logger.error("tool_data_source_failed", { tool, error: String(error) });
    return errorResult(fallback);
  }

  return {
    async listTickets(args) {
      try {
        const { items, total } = store.listTickets({ status: args.status }, args.page, args.per_page);
        return textResult({
          source: "seeded-demo",
          status: args.status ?? null,
          tickets: items,
          pagination: {
            page: args.page,
            per_page: args.per_page,
            total,
            total_pages: total === 0 ? 0 : Math.ceil(total / args.per_page),
          },
        });
      } catch (error) {
        return fail("list_tickets", LIST_UNAVAILABLE_MESSAGE, error);
      }
    },

    async createTicket(args) {
      try {
        const ticket = store.createTicket({
          customer: args.customer,
          subject: args.subject,
          priority: args.priority,
        });
        return textResult({ source: "seeded-demo", ticket });
      } catch (error) {
        return fail("create_ticket", CREATE_UNAVAILABLE_MESSAGE, error);
      }
    },
  };
}
