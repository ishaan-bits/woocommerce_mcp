import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Logger } from "./logger.ts";
import type { SupportDataSource } from "./support-store.ts";
import { createToolHandlers } from "./tool-handlers.ts";
import { createTicketInput, listTicketsInput } from "./tool-schemas.ts";
import { VERSION } from "./version.ts";

export interface McpServerOptions {
  store: SupportDataSource;
  logger: Logger;
  name?: string;
  version?: string;
}

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

export function createMcpServer(options: McpServerOptions): McpServer {
  const server = new McpServer(
    {
      name: options.name ?? "support-mcp",
      version: options.version ?? VERSION,
    },
    {
      instructions:
        "This server exposes a small SUPPORT DESK DEMO: a deterministic, seeded in-memory ticket dataset. " +
        "No real helpdesk, CRM or ticketing system is connected, and tickets created here live only in this process. " +
        "Ticket statuses are open, pending and resolved; priorities are low, normal and high. " +
        "Tool results are JSON text with a source field of \"seeded-demo\". " +
        "list_tickets is read-only; create_ticket appends a new open ticket and is not idempotent. " +
        "Failures are returned as tool results with isError set to true; invalid arguments are reported as validation error results.",
    },
  );

  const handlers = createToolHandlers(options.store, options.logger);

  server.registerTool(
    "list_tickets",
    {
      title: "List support tickets",
      description:
        "List tickets from the seeded demo support desk, one page at a time, optionally filtered by status (open, pending, resolved). " +
        "Read-only. Returns tickets (id, customer, subject, status, priority, created_at, updated_at, messages) plus pagination.",
      inputSchema: listTicketsInput,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (args) => handlers.listTickets(args),
  );

  server.registerTool(
    "create_ticket",
    {
      title: "Create support ticket",
      description:
        "Create a new open ticket on the seeded demo support desk with customer and subject (trimmed, required) and an optional priority (default normal). " +
        "Each call appends a new ticket with the next id, so it is not idempotent. Mutating tool.",
      inputSchema: createTicketInput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (args) => handlers.createTicket(args),
  );

  return server;
}
