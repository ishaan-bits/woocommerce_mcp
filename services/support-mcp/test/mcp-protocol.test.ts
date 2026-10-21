import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { SEEDED_TICKET_COUNT } from "../src/support-store.ts";
import { parsedContent, startHarness, textContent, type TestHarness } from "./helpers/test-server.ts";

const EXPECTED_TOOLS = ["create_ticket", "list_tickets"];

interface ListPayload {
  source: string;
  status: string | null;
  tickets: Array<{ id: number; customer: string; subject: string; status: string; priority: string }>;
  pagination: { page: number; per_page: number; total: number; total_pages: number };
}

interface CreatePayload {
  source: string;
  ticket: { id: number; customer: string; subject: string; status: string; priority: string; messages: number };
}

describe("mcp protocol over Streamable HTTP", () => {
  let harness: TestHarness;

  before(async () => {
    harness = await startHarness();
  });

  after(async () => {
    await harness.close();
  });

  test("initialize and tools/list expose exactly the two tools with schemas", async () => {
    const { tools } = await harness.client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name).sort(), EXPECTED_TOOLS);
    for (const tool of tools) {
      assert.ok(typeof tool.description === "string" && tool.description.length > 0, `${tool.name} needs a description`);
      assert.equal(tool.inputSchema.type, "object", `${tool.name} needs an object input schema`);
    }
    const create = tools.find((tool) => tool.name === "create_ticket");
    assert.deepEqual([...((create?.inputSchema as { required?: string[] }).required ?? [])].sort(), [
      "customer",
      "subject",
    ]);
    const list = tools.find((tool) => tool.name === "list_tickets");
    assert.equal((list?.inputSchema as { required?: string[] }).required, undefined);
  });

  test("descriptions are honest about the seeded demo data", async () => {
    const { tools } = await harness.client.listTools();
    const text = tools.map((tool) => tool.description).join(" ");
    assert.match(text, /seeded demo support desk/);
    const instructions = (await harness.client.getServerVersion())?.name;
    assert.equal(instructions, "support-mcp");
  });

  test("list_tickets returns the seeded dataset with pagination defaults", async () => {
    const result = await harness.client.callTool({ name: "list_tickets", arguments: {} });
    assert.ok(result.isError !== true, textContent(result));
    const payload = parsedContent(result) as ListPayload;
    assert.equal(payload.source, "seeded-demo");
    assert.equal(payload.tickets.length, SEEDED_TICKET_COUNT, "all 8 tickets fit on one default page");
    assert.equal(payload.pagination.total, SEEDED_TICKET_COUNT);
    assert.equal(payload.pagination.page, 1);
    assert.equal(payload.pagination.per_page, 10);
    assert.equal(payload.pagination.total_pages, 1, "8 tickets fit on one default page");
    assert.equal(payload.status, null);
    assert.ok(payload.tickets.every((ticket) => ticket.id >= 1001 && ticket.id <= 1008));
  });

  test("list_tickets filters by status and by page", async () => {
    const open = parsedContent(
      await harness.client.callTool({ name: "list_tickets", arguments: { status: "open" } }),
    ) as ListPayload;
    assert.equal(open.pagination.total, 4);
    assert.ok(open.tickets.every((ticket) => ticket.status === "open"));
    assert.equal(open.status, "open");

    const page2 = parsedContent(
      await harness.client.callTool({ name: "list_tickets", arguments: { page: 2, per_page: 5 } }),
    ) as ListPayload;
    assert.equal(page2.tickets.length, 3);
    assert.equal(page2.pagination.total, SEEDED_TICKET_COUNT);
  });

  test("create_ticket appends an open ticket visible to later reads", async () => {
    const created = await harness.client.callTool({
      name: "create_ticket",
      arguments: { customer: "northwind-traders", subject: "Second follow-up on order 512", priority: "high" },
    });
    assert.ok(created.isError !== true, textContent(created));
    const payload = parsedContent(created) as CreatePayload;
    assert.equal(payload.source, "seeded-demo");
    assert.equal(payload.ticket.id, 1009);
    assert.equal(payload.ticket.status, "open");
    assert.equal(payload.ticket.priority, "high");
    assert.equal(payload.ticket.messages, 1);

    const listed = parsedContent(
      await harness.client.callTool({ name: "list_tickets", arguments: { per_page: 100 } }),
    ) as ListPayload;
    assert.equal(listed.pagination.total, SEEDED_TICKET_COUNT + 1);
    assert.equal(listed.tickets.at(-1)?.id, 1009);

    // Default priority is normal when omitted
    const defaulted = parsedContent(
      await harness.client.callTool({ name: "create_ticket", arguments: { customer: "a", subject: "b" } }),
    ) as CreatePayload;
    assert.equal(defaulted.ticket.priority, "normal");
    assert.equal(defaulted.ticket.id, 1010);
  });

  test("invalid tool arguments produce a validation error result", async () => {
    const missingSubject = await harness.client.callTool({ name: "create_ticket", arguments: { customer: "a" } });
    assert.equal(missingSubject.isError, true);
    assert.match(textContent(missingSubject), /Input validation error/);

    const badStatus = await harness.client.callTool({ name: "list_tickets", arguments: { status: "closed" } });
    assert.equal(badStatus.isError, true);
    assert.match(textContent(badStatus), /Input validation error/);

    const badPage = await harness.client.callTool({ name: "list_tickets", arguments: { per_page: 5000 } });
    assert.equal(badPage.isError, true);
    assert.match(textContent(badPage), /Input validation error/);
  });

  test("results are bounded by per_page even for huge pages", async () => {
    const result = await harness.client.callTool({ name: "list_tickets", arguments: { per_page: 100 } });
    const payload = parsedContent(result) as ListPayload;
    assert.ok(payload.tickets.length <= 100);
    assert.ok(payload.pagination.per_page <= 100);
  });
});
