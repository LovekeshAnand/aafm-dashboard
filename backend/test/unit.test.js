// Pure unit tests: no database, no network.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { KPIS, METRICS } from "../src/constants.js";
import { kpiTotals } from "../src/controllers/metric.controller.js";
import { hashPassword, verifyPassword } from "../src/utils/password.js";
import { hashToken } from "../src/utils/session.js";

describe("KPI definitions", () => {
  test("every KPI is a ratio of two known base metrics", () => {
    for (const [kpi, { numerator, denominator }] of Object.entries(KPIS)) {
      assert.ok(METRICS.includes(numerator), `${kpi} numerator`);
      assert.ok(METRICS.includes(denominator), `${kpi} denominator`);
      assert.notEqual(numerator, denominator, `${kpi} is not a constant 1`);
    }
  });

  test("ARPU is revenue / users (the brief's example)", () => {
    assert.deepEqual(KPIS.arpu, { numerator: "revenue", denominator: "users" });
  });
});

describe("kpiTotals", () => {
  const row = (metric, current, previous) => ({ metric, current, previous });

  test("computes a ratio of sums for both periods", () => {
    const kpis = kpiTotals([
      row("revenue", 1000, 800),
      row("users", 250, 200),
      row("clicks", 30, 20),
      row("page_views", 600, 400),
      row("errors", 6, 2),
    ]);
    const byKey = Object.fromEntries(kpis.map((k) => [k.kpi, k]));
    assert.equal(byKey.arpu.current, 4);
    assert.equal(byKey.arpu.previous, 4);
    assert.equal(byKey.ctr.current, 0.05);
    assert.equal(byKey.error_rate.current, 0.01);
    assert.equal(byKey.error_rate.previous, 0.005);
  });

  test("a zero or missing denominator gives null, never Infinity or NaN", () => {
    const kpis = kpiTotals([row("revenue", 500, 0), row("users", 0, 0)]);
    const arpu = kpis.find((k) => k.kpi === "arpu");
    assert.equal(arpu.current, null);
    assert.equal(arpu.previous, null);
    assert.equal(
      kpis.find((k) => k.kpi === "ctr").current,
      null,
      "page_views missing"
    );
  });
});

describe("password hashing", () => {
  test("verifies the right password and rejects a wrong one", async () => {
    const hash = await hashPassword("correct horse battery staple");
    assert.match(hash, /^scrypt\$[^$]+\$[^$]+$/);
    assert.equal(
      await verifyPassword("correct horse battery staple", hash),
      true
    );
    assert.equal(await verifyPassword("wrong password!!", hash), false);
  });

  test("the same password hashes differently each time (random salt)", async () => {
    assert.notEqual(
      await hashPassword("same-password-1"),
      await hashPassword("same-password-1")
    );
  });

  test("a malformed stored hash fails closed", async () => {
    for (const bad of ["", "plain-text", "bcrypt$x$y", "scrypt$$", null]) {
      assert.equal(await verifyPassword("anything", bad), false, String(bad));
    }
  });
});

describe("session token hashing", () => {
  test("is deterministic, 32 bytes, and never the token itself", () => {
    const a = hashToken("token-abc");
    assert.equal(a.length, 32);
    assert.deepEqual(a, hashToken("token-abc"));
    assert.notDeepEqual(a, hashToken("token-abd"));
    assert.notEqual(a.toString(), "token-abc");
  });
});
