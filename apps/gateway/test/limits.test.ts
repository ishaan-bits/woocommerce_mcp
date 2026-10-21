import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { createSemaphore, createTokenBucketLimiter } from "../src/limits.ts";
import { GatewayError } from "../src/errors.ts";

describe("createTokenBucketLimiter (C7 rate limit)", () => {
  test("allows up to capacity, then refuses until refill", () => {
    let clock = 0;
    const limiter = createTokenBucketLimiter({
      capacity: 3,
      refillPerMinute: 60,
      now: () => clock,
    });
    assert.equal(limiter.tryTake("key"), true);
    assert.equal(limiter.tryTake("key"), true);
    assert.equal(limiter.tryTake("key"), true);
    assert.equal(limiter.tryTake("key"), false);
    clock += 1_000; // 60/min = 1 token per second
    assert.equal(limiter.tryTake("key"), true);
    assert.equal(limiter.tryTake("key"), false);
  });

  test("keys are independent", () => {
    const limiter = createTokenBucketLimiter({ capacity: 1, refillPerMinute: 60 });
    assert.equal(limiter.tryTake("a"), true);
    assert.equal(limiter.tryTake("a"), false);
    assert.equal(limiter.tryTake("b"), true);
  });

  test("reset restores the bucket", () => {
    const limiter = createTokenBucketLimiter({ capacity: 1, refillPerMinute: 60 });
    assert.equal(limiter.tryTake("a"), true);
    assert.equal(limiter.tryTake("a"), false);
    limiter.reset("a");
    assert.equal(limiter.tryTake("a"), true);
  });

  test("refill never exceeds capacity", () => {
    let clock = 0;
    const limiter = createTokenBucketLimiter({
      capacity: 2,
      refillPerMinute: 60_000,
      now: () => clock,
    });
    assert.equal(limiter.tryTake("a"), true);
    assert.equal(limiter.tryTake("a"), true);
    assert.equal(limiter.tryTake("a"), false);
    clock += 3_600_000;
    assert.equal(limiter.tryTake("a"), true);
    assert.equal(limiter.tryTake("a"), true);
    assert.equal(limiter.tryTake("a"), false);
  });

  test("zero refill means unlimited (disabled mode)", () => {
    const limiter = createTokenBucketLimiter({ capacity: 1, refillPerMinute: 0 });
    for (let i = 0; i < 100; i += 1) {
      assert.equal(limiter.tryTake("a"), true);
    }
  });
});

describe("createSemaphore (C7 concurrency)", () => {
  test("limits concurrency and queues waiters until release", async () => {
    const semaphore = createSemaphore(1);
    const first = await semaphore.acquire(1_000);
    let secondResolved = false;
    const secondPromise = semaphore.acquire(1_000).then((release) => {
      secondResolved = true;
      return release;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(secondResolved, false);
    first();
    const second = await secondPromise;
    assert.equal(secondResolved, true);
    second();
  });

  test("acquire times out with a busy GatewayError when the limit is exhausted", async () => {
    const semaphore = createSemaphore(1);
    const release = await semaphore.acquire(1_000);
    try {
      await assert.rejects(
        () => semaphore.acquire(50),
        (error: unknown) => error instanceof GatewayError && error.code === "busy",
      );
    } finally {
      release();
    }
  });

  test("release frees a slot for new acquisitions", async () => {
    const semaphore = createSemaphore(2);
    const a = await semaphore.acquire(100);
    const b = await semaphore.acquire(100);
    a();
    b();
    const c = await semaphore.acquire(100);
    c();
  });
});
