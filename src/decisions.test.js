import * as assert from "node:assert";
import { test } from "node:test";
import { shouldSettle, shouldSub } from "./decisions.js";

// ── shouldSettle ──────────────────────────────────────────

test("shouldSettle: Closed + valid IOU → true", () => {
  assert.strictEqual(
    shouldSettle("Closed", { iouAmt: "5000000", sig: "abcd" }),
    true,
  );
});

test("shouldSettle: no IOU data → false", () => {
  assert.strictEqual(shouldSettle("Closed", undefined), false);
});

test("shouldSettle: Opened state → false", () => {
  assert.strictEqual(
    shouldSettle("Opened", { iouAmt: "5000000", sig: "abcd" }),
    false,
  );
});

test("shouldSettle: zero amount → false", () => {
  assert.strictEqual(
    shouldSettle("Closed", { iouAmt: "0", sig: "abcd" }),
    false,
  );
});

test("shouldSettle: empty sig → false", () => {
  assert.strictEqual(
    shouldSettle("Closed", { iouAmt: "5000000", sig: "" }),
    false,
  );
});

test("shouldSettle: Settled state → false", () => {
  assert.strictEqual(
    shouldSettle("Settled", { iouAmt: "5000000", sig: "abcd" }),
    false,
  );
});

// ── shouldSub ─────────────────────────────────────────────

test("shouldSub: iouAmt > sub + threshold → true", () => {
  assert.strictEqual(
    shouldSub({ iouAmt: "10000000", sig: "abcd" }, 5000000n, 0n),
    true,
  );
});

test("shouldSub: iouAmt = sub → false", () => {
  assert.strictEqual(
    shouldSub({ iouAmt: "5000000", sig: "abcd" }, 5000000n, 0n),
    false,
  );
});

test("shouldSub: below threshold → false", () => {
  assert.strictEqual(
    shouldSub({ iouAmt: "6000000", sig: "abcd" }, 5000000n, 2000000n),
    false,
  );
});

test("shouldSub: empty sig → false", () => {
  assert.strictEqual(
    shouldSub({ iouAmt: "10000000", sig: "" }, 5000000n, 0n),
    false,
  );
});

test("shouldSub: no IOU data → false", () => {
  assert.strictEqual(shouldSub(undefined, 0n, 0n), false);
});

test("shouldSub: exactly at threshold boundary → false", () => {
  assert.strictEqual(
    shouldSub({ iouAmt: "7000000", sig: "abcd" }, 5000000n, 2000000n),
    false,
  );
});

test("shouldSub: just above threshold boundary → true", () => {
  assert.strictEqual(
    shouldSub({ iouAmt: "7000001", sig: "abcd" }, 5000000n, 2000000n),
    true,
  );
});
