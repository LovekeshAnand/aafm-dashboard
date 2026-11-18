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

// ---------------------------------------------------------------------------
// Tier 3 D: custom metric formulas
// ---------------------------------------------------------------------------
const { evaluateFormula, FormulaError, formulaSql, metricsOf, parseFormula } =
  await import("../src/utils/formula.js");

describe("custom metric formulas (Tier 3 D)", () => {
  const value = (formula, totals) =>
    evaluateFormula(parseFormula(formula), totals);

  test("respects precedence, parentheses and unary minus", () => {
    const t = { revenue: 100, clicks: 20, errors: 5, page_views: 50, users: 4 };
    assert.equal(value("revenue / users", t), 25);
    assert.equal(value("clicks - errors * 2", t), 10);
    assert.equal(value("(clicks - errors) * 2", t), 30);
    assert.equal(value("(clicks - errors) / page_views * 100", t), 30);
    assert.equal(value("-errors + clicks", t), 15);
    assert.equal(value("revenue / (users + 1)", t), 20);
    assert.equal(value("revenue * 0.5", t), 50);
  });

  test("division by zero is null, never Infinity", () => {
    assert.equal(value("revenue / users", { revenue: 10, users: 0 }), null);
    assert.equal(
      value("revenue / (users - users)", { revenue: 1, users: 3 }),
      null
    );
  });

  test("lists the metrics it reads", () => {
    assert.deepEqual(
      metricsOf(parseFormula("(clicks - errors) / clicks + revenue")).sort(),
      ["clicks", "errors", "revenue"]
    );
  });

  test("rejects bad input with the position of the problem", () => {
    const fails = (formula, message, position) =>
      assert.throws(
        () => parseFormula(formula),
        (err) =>
          err instanceof FormulaError &&
          err.message.includes(message) &&
          (position === undefined || err.position === position)
      );
    fails("", "empty", 0);
    fails("revenue +", "ends too early", 9);
    fails("(revenue / users", 'Missing ")"', 16);
    fails("revenue / users)", 'Unexpected ")"', 15);
    fails("profit / users", 'Unknown metric "profit"', 0);
    fails("revenue ^ 2", 'Unexpected character "^"', 8);
    fails("1.2.3 * revenue", "Invalid number", 0);
    fails("42", "at least one metric");
    fails("revenue + ".repeat(20) + "users", "At most 200 characters");
  });

  test("injection attempts never parse", () => {
    for (const formula of [
      "revenue; DROP TABLE users",
      "revenue) FROM metric_points --",
      "revenue' OR '1'='1",
      "pg_sleep(10)",
      "revenue /* */ users",
    ])
      assert.throws(() => parseFormula(formula), FormulaError, formula);
  });

  test("generated SQL holds only placeholders; names and numbers are parameters", () => {
    const params = [];
    const sql = formulaSql(
      parseFormula("(clicks - errors) / page_views * 100"),
      params
    );
    assert.deepEqual(params, ["clicks", "errors", "page_views", 100]);
    assert.doesNotMatch(sql, /clicks|errors|page_views|100/);
    assert.match(sql, /NULLIF\(/, "division is guarded");
  });
});

// ---------------------------------------------------------------------------
// Tier 3 C: webhook signing and the SSRF guard
// ---------------------------------------------------------------------------
const { checkUrl, isBlocked, newSecret, signature } =
  await import("../src/webhooks.js");

describe("webhook signing (Standard Webhooks)", () => {
  test("matches the spec's published test vector", () => {
    assert.equal(
      signature(
        "whsec_REDACTED",
        "msg_p5jXN8AQM9LWM0D4loKWxJek",
        1614265330,
        '{"test": 2432232314}'
      ),
      "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE="
    );
  });

  test("secrets are whsec_ + 32 random bytes", () => {
    const secret = newSecret();
    assert.match(secret, /^whsec_[A-Za-z0-9+/]+=*$/);
    assert.equal(Buffer.from(secret.slice(6), "base64").length, 32);
    assert.notEqual(secret, newSecret());
  });
});

describe("SSRF guard (OWASP)", () => {
  test("blocks private, loopback, link-local, metadata and mapped addresses", () => {
    for (const address of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "::1",
      "fd00::1",
      "fe80::1",
      "::ffff:127.0.0.1",
      "::ffff:a9fe:a9fe", // 169.254.169.254, hex form
    ])
      assert.ok(isBlocked(address), address);
    for (const address of [
      "93.184.216.34",
      "1.1.1.1",
      "::ffff:8.8.8.8",
      "2606:4700::1111",
    ])
      assert.ok(!isBlocked(address), address);
  });

  test("accepts only plain http(s) URLs to public addresses", () => {
    delete process.env.WEBHOOK_ALLOW_PRIVATE;
    assert.equal(
      checkUrl("https://hooks.example.com/x").hostname,
      "hooks.example.com"
    );
    for (const url of [
      "ftp://example.com/x",
      "file:///etc/passwd",
      "https://user:pass@example.com/",
      "http://127.0.0.1:8000/",
      "http://169.254.169.254/latest/meta-data",
      "http://[::1]/",
    ])
      assert.throws(() => checkUrl(url), Error, url);
  });
});

// ---------------------------------------------------------------------------
// Prompt 50: webhook secrets encrypted at rest (AES-256-GCM)
// ---------------------------------------------------------------------------
const { keyringFrom, open, seal } = await import("../src/utils/secret-box.js");

describe("secret encryption (AES-256-GCM)", () => {
  const key = () => Buffer.alloc(32, Math.random() * 255).toString("base64");
  const k1 = keyringFrom({ current: "k1", keys: { k1: key() } });

  test("round-trips, with a fresh IV every time", () => {
    const a = seal("whsec_abc", "hook-1", k1);
    assert.notEqual(a, seal("whsec_abc", "hook-1", k1));
    assert.match(a, /^v1:k1:/);
    assert.equal(open(a, "hook-1", k1), "whsec_abc");
  });

  test("refuses another webhook's id, an edited ciphertext or an unknown key", () => {
    const sealed = seal("whsec_abc", "hook-1", k1);
    assert.throws(() => open(sealed, "hook-2", k1));
    const parts = sealed.split(":");
    parts[4] = Buffer.from("tampered!").toString("base64");
    assert.throws(() => open(parts.join(":"), "hook-1", k1));
    const other = keyringFrom({ current: "k9", keys: { k9: key() } });
    assert.throws(() => open(sealed, "hook-1", other), /not in the keyring/);
    assert.throws(() => open("whsec_plain", "hook-1", k1), /sealed v1 format/);
  });

  test("after a rotation, old ciphertexts still open and new ones use the new key", () => {
    const old = seal("whsec_abc", "hook-1", k1);
    const both = keyringFrom({
      current: "k2",
      keys: { k1: k1.keys.k1.toString("base64"), k2: key() },
    });
    assert.equal(open(old, "hook-1", both), "whsec_abc");
    assert.match(seal("x", "hook-1", both), /^v1:k2:/);
  });

  test("a malformed keyring is rejected up front", () => {
    assert.throws(
      () => keyringFrom({ current: "k1", keys: { k1: "c2hvcnQ=" } }),
      /32 bytes/
    );
    assert.throws(
      () => keyringFrom({ current: "k2", keys: { k1: key() } }),
      /missing/
    );
    assert.throws(() => keyringFrom({}), /keyring needs/);
  });
});

// ---------------------------------------------------------------------------
// Prompt 54: preflight (problems-log #8/#40) and audit checkpoint signatures (#39)
// ---------------------------------------------------------------------------
const { assertOwnerBypassesRls, assertFunctionOwnerBypassesRls } =
  await import("../src/db/preflight.js");
const { sign } = await import("../src/utils/audit-checkpoints.js");

describe("database owner preflight", () => {
  const fake = (rows) => ({ query: async () => ({ rows }) });

  test("refuses an owner that can't bypass RLS, with the fix in the message", async () => {
    await assert.rejects(
      assertOwnerBypassesRls(fake([{ rolname: "app_owner", ok: false }])),
      /ALTER ROLE "app_owner" BYPASSRLS/
    );
    await assertOwnerBypassesRls(fake([{ rolname: "postgres", ok: true }]));
    await assert.rejects(
      assertFunctionOwnerBypassesRls(fake([{ rolname: "x", ok: false }])),
      /BYPASSRLS/
    );
    await assert.rejects(
      assertFunctionOwnerBypassesRls(fake([])),
      /npm run migrate/
    );
  });
});

describe("audit checkpoint signatures", () => {
  const ring = keyringFrom({
    current: "k1",
    keys: {
      k1: Buffer.alloc(32, 1).toString("base64"),
      k2: Buffer.alloc(32, 2).toString("base64"),
    },
  });
  const hash = Buffer.from("ab".repeat(32), "hex");

  test("depend on the org, the entry, its hash and the key", () => {
    const base = sign("org-1", 42, hash, ring, "k1");
    assert.equal(base, sign("org-1", 42, hash, ring, "k1"), "deterministic");
    assert.notEqual(base, sign("org-2", 42, hash, ring, "k1"));
    assert.notEqual(base, sign("org-1", 43, hash, ring, "k1"));
    assert.notEqual(base, sign("org-1", 42, Buffer.alloc(32), ring, "k1"));
    assert.notEqual(base, sign("org-1", 42, hash, ring, "k2"));
  });
});
