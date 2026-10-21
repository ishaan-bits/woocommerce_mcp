import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { z } from "zod";
import {
  createTicketInput,
  listTicketsInput,
  CUSTOMER_MESSAGE,
  PAGE_MESSAGE,
  PER_PAGE_MESSAGE,
  PRIORITY_MESSAGE,
  STATUS_MESSAGE,
  SUBJECT_MESSAGE,
} from "../src/tool-schemas.ts";

const listSchema = z.object(listTicketsInput);
const createSchema = z.object(createTicketInput);

describe("list_tickets input", () => {
  test("defaults page and per_page like the other MCP servers", () => {
    const parsed = listSchema.parse({});
    assert.equal(parsed.page, 1);
    assert.equal(parsed.per_page, 10);
    assert.equal(parsed.status, undefined);
  });

  test("accepts a status filter and coerced numeric strings", () => {
    const parsed = listSchema.parse({ status: "pending", page: "2", per_page: "5" });
    assert.equal(parsed.status, "pending");
    assert.equal(parsed.page, 2);
    assert.equal(parsed.per_page, 5);
  });

  test("rejects out-of-range pages and per_page", () => {
    for (const args of [{ page: 0 }, { page: 1.5 }, { per_page: 0 }, { per_page: 101 }]) {
      const result = listSchema.safeParse(args);
      assert.equal(result.success, false, JSON.stringify(args));
      const issue = result.success ? "" : result.error.issues[0]?.message ?? "";
      assert.ok(issue === PAGE_MESSAGE || issue === PER_PAGE_MESSAGE, issue);
    }
  });

  test("rejects unknown statuses", () => {
    const result = listSchema.safeParse({ status: "closed" });
    assert.equal(result.success, false);
    if (!result.success) {
      assert.equal(result.error.issues[0]?.message, STATUS_MESSAGE);
    }
  });

  test("rejects a non-string status", () => {
    assert.equal(listSchema.safeParse({ status: 7 }).success, false);
  });
});

describe("create_ticket input", () => {
  test("requires customer and subject, defaults priority to normal", () => {
    assert.equal(createSchema.safeParse({}).success, false);
    assert.equal(createSchema.safeParse({ customer: "a" }).success, false, "subject is required");
    assert.equal(createSchema.safeParse({ subject: "b" }).success, false, "customer is required");
    const parsed = createSchema.parse({ customer: "northwind-traders", subject: "Late order" });
    assert.equal(parsed.priority, "normal");
  });

  test("trims and enforces length limits", () => {
    const parsed = createSchema.parse({ customer: "  northwind-traders ", subject: " Late order " });
    assert.equal(parsed.customer, "northwind-traders");
    assert.equal(parsed.subject, "Late order");
    assert.equal(createSchema.safeParse({ customer: "x", subject: "y".repeat(201) }).success, false);
    assert.equal(createSchema.safeParse({ customer: "x".repeat(121), subject: "y" }).success, false);
  });

  test("blank-after-trim values are rejected with the named message", () => {
    const blankSubject = createSchema.safeParse({ customer: "x", subject: "   " });
    assert.equal(blankSubject.success, false);
    if (!blankSubject.success) {
      assert.equal(blankSubject.error.issues[0]?.message, SUBJECT_MESSAGE);
    }
    const blankCustomer = createSchema.safeParse({ customer: "   ", subject: "y" });
    assert.equal(blankCustomer.success, false);
    if (!blankCustomer.success) {
      assert.equal(blankCustomer.error.issues[0]?.message, CUSTOMER_MESSAGE);
    }
  });

  test("rejects unknown priorities", () => {
    const result = createSchema.safeParse({ customer: "x", subject: "y", priority: "urgent" });
    assert.equal(result.success, false);
    if (!result.success) {
      assert.equal(result.error.issues[0]?.message, PRIORITY_MESSAGE);
    }
  });
});
