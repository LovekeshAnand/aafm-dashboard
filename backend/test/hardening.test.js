// Production hardening (docs/edge-case-audit.md, Prompts 51-53) over real HTTP and a real DB.
// Runs in its own throwaway organization ("hard-<timestamp>"), so caps, rate limits and audit
// compaction here can never disturb the other suites running in parallel.
import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import { after, before, describe, test } from "node:test";
import pg from "pg";
import { io as connect } from "socket.io-client";

const ORIGIN = "http://localhost:3000";
Object.assign(process.env, {
  CORS_ORIGIN: ORIGIN,
  AUTH_RATE_LIMIT: "1000",
  API_RATE_LIMIT: "60",
  API_WRITE_RATE_LIMIT: "30",
  DB_POOL_MAX: "4",
  DB_CONNECT_TIMEOUT_MS: "500",
  WEBHOOK_TIMEOUT_MS: "1500",
  WEBHOOK_ALLOW_PRIVATE: "1",
});
const { app } = await import("../src/app.js");
const { pool } = await import("../src/db/pool.js");
const { initRealtime } = await import("../src/realtime.js");
const { runHousekeeping } = await import("../src/maintenance.js");
const { checkUrl, send } = await import("../src/webhooks.js");
const { hashPassword } = await import("../src/utils/password.js");

const PASSWORD = "Hardening-test-password-1";
const owner = new pg.Client({
  connectionString: process.env.MIGRATION_DATABASE_URL,
});
let server, io, base, org, team, slug;
const users = {};
const sockets = [];

before(async () => {
  server = app.listen(0);
  io = initRealtime(server);
  base = `http://127.0.0.1:${server.address().port}`;
  await owner.connect();
  slug = `hard-${Date.now()}`;
  ({
    rows: [org],
  } = await owner.query(
    "INSERT INTO organizations (slug, name) VALUES ($1, 'Hardening') RETURNING id",
    [slug]
  ));
  ({
    rows: [team],
  } = await owner.query(
    "INSERT INTO teams (org_id, name) VALUES ($1, 'Ops') RETURNING id",
    [org.id]
  ));
  const hash = await hashPassword(PASSWORD);
  for (const [key, role] of [
    ["boss", "super_admin"],
    ["admin", "admin"],
    ["member", "editor"],
  ]) {
    const {
      rows: [u],
    } = await owner.query(
      "INSERT INTO users (org_id, email, name, password_hash) VALUES ($1, $2, $3, $4) RETURNING id",
      [org.id, `${key}@hard.test`, `Hard ${key}`, hash]
    );
    users[key] = u.id;
    await owner.query(
      "INSERT INTO memberships (user_id, org_id, team_id, role) VALUES ($1, $2, $3, $4)",
      [u.id, org.id, role === "super_admin" ? null : team.id, role]
    );
  }
});

after(async () => {
  sockets.forEach((s) => s.disconnect());
  await owner.query("DELETE FROM organizations WHERE id = $1", [org.id]);
  await owner.end();
  await new Promise((resolve) => io.close(resolve));
  await pool.end();
});

const signIn = async (user) => {
  let cookie = "";
  const call = async (method, path, body, headers = {}) => {
    const res = await fetch(`${base}/api/v1${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        "X-Requested-With": "test",
        cookie,
        ...headers,
      },
      body: body && JSON.stringify(body),
    });
    const set = res.headers.getSetCookie()[0]?.split(";")[0];
    if (set !== undefined) cookie = set.endsWith("=") ? "" : set;
    return { status: res.status, headers: res.headers, body: await res.json() };
  };
  const login = await call("POST", "/auth/login", {
    org: slug,
    email: `${user}@hard.test`,
    password: PASSWORD,
  });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  return { call, cookie: () => cookie };
};

describe("rate limits (E1)", () => {
  test("each session gets its own budget; over it, 429 with Retry-After", async () => {
    const a = await signIn("member");
    let res;
    for (let i = 0; i < 60; i++) res = await a.call("GET", "/projects");
    assert.equal(res.status, 200, "the 60th request is still allowed");
    res = await a.call("GET", "/projects");
    assert.equal(res.status, 429);
    assert.ok(Number(res.headers.get("retry-after")) > 0);
    const b = await signIn("member");
    assert.equal(
      (await b.call("GET", "/projects")).status,
      200,
      "another session is unaffected"
    );
    // #13: the counter lives in Postgres, shared by every API instance, not in this process.
    const { rows } = await owner.query(
      "SELECT max(hits) AS hits FROM rate_limits WHERE key LIKE 'api:60:%'"
    );
    assert.ok(rows[0].hits >= 61, `shared counter (${rows[0].hits})`);
  });

  test("writes have a tighter budget", async () => {
    const a = await signIn("member");
    let res;
    for (let i = 0; i < 30; i++)
      res = await a.call("POST", "/dashboards", { name: "x".repeat(200) }); // 400, still counted
    assert.equal(res.status, 400);
    res = await a.call("POST", "/dashboards", { name: "y" });
    assert.equal(res.status, 429);
  });
});

describe("caps enforced by the database (E2-E4)", () => {
  test("projects, webhooks, custom metrics and teams stop at their limits", async () => {
    // Fill up to the cap as the owner (the trigger applies to everyone), then ask the API.
    await owner.query(
      `INSERT INTO projects (org_id, team_id, name)
       SELECT $1, $2, 'P' || g FROM generate_series(1, 24) g`,
      [org.id, team.id]
    );
    await owner.query(
      `INSERT INTO custom_metrics (org_id, team_id, name, formula)
       SELECT $1, $2, 'M' || g, 'clicks' FROM generate_series(1, 50) g`,
      [org.id, team.id]
    );
    await owner.query(
      `INSERT INTO webhooks (org_id, team_id, url, events, secret)
       SELECT $1, $2, 'https://hooks.example.invalid/' || g, ARRAY['alert.opened'], 'v1:test'
       FROM generate_series(1, 10) g`,
      [org.id, team.id]
    );
    await owner.query(
      `INSERT INTO teams (org_id, name) SELECT $1, 'T' || g FROM generate_series(1, 49) g`,
      [org.id]
    );

    const boss = await signIn("boss");
    const refused = async (path, body, label) => {
      const res = await boss.call("POST", path, body);
      assert.equal(res.status, 409, label);
      assert.match(res.body.message, /^Limit reached: at most \d+ /, label);
    };
    await refused(
      "/projects",
      { name: "one more", team_id: team.id },
      "projects"
    );
    await refused(
      "/custom-metrics",
      { name: "one more", formula: "clicks", team_id: team.id },
      "metrics"
    );
    await refused(
      "/webhooks",
      {
        url: "https://hooks.example.invalid/x",
        events: ["alert.opened"],
        team_id: team.id,
      },
      "webhooks"
    );
    await refused("/teams", { name: "one more" }, "teams");
    await owner.query(
      "DELETE FROM teams WHERE org_id = $1 AND name LIKE 'T%'",
      [org.id]
    );
    await owner.query("DELETE FROM webhooks WHERE team_id = $1", [team.id]);
    await owner.query(
      "DELETE FROM projects WHERE team_id = $1 AND name LIKE 'P%'",
      [team.id]
    );
    await owner.query("DELETE FROM custom_metrics WHERE team_id = $1", [
      team.id,
    ]);
  });
});

describe("database pool and time limits (E7-E9)", () => {
  test("an idle-connection error is handled, not a crash", () => {
    assert.ok(pool.listenerCount("error") > 0);
  });

  test("an exhausted pool answers 503 + Retry-After instead of hanging", async () => {
    const boss = await signIn("boss");
    // Take every free connection until the pool says it's exhausted (the Socket.IO adapter
    // permanently holds one for LISTEN), then always give them back.
    const held = [];
    try {
      for (;;) held.push(await pool.connect());
    } catch {
      // the pool is now exhausted
    }
    try {
      assert.ok(held.length > 0);
      const started = Date.now();
      const res = await boss.call("GET", "/projects");
      assert.equal(res.status, 503);
      assert.equal(res.headers.get("retry-after"), "5");
      assert.ok(Date.now() - started < 3000, "fails fast");
    } finally {
      held.forEach((client) => client.release());
    }
    assert.equal((await boss.call("GET", "/projects")).status, 200, "recovers");
  });

  test("the app role has statement, lock and idle-transaction time limits", async () => {
    const client = await pool.connect();
    try {
      const show = async (name) =>
        (await client.query(`SHOW ${name}`)).rows[0][name];
      assert.equal(await show("statement_timeout"), "10s");
      assert.equal(await show("lock_timeout"), "5s");
      assert.equal(await show("idle_in_transaction_session_timeout"), "30s");
    } finally {
      client.release();
    }
  });
});

describe("live connections end with the membership (E12)", () => {
  test("removing a member closes their socket at once", async () => {
    const {
      rows: [u],
    } = await owner.query(
      "INSERT INTO users (org_id, email, name, password_hash) VALUES ($1, 'gone@hard.test', 'Gone', $2) RETURNING id",
      [org.id, await hashPassword(PASSWORD)]
    );
    const {
      rows: [m],
    } = await owner.query(
      "INSERT INTO memberships (user_id, org_id, team_id, role) VALUES ($1, $2, $3, 'viewer') RETURNING id",
      [u.id, org.id, team.id]
    );
    const gone = await signIn("gone");
    const socket = connect(base, {
      transports: ["websocket"],
      extraHeaders: { cookie: gone.cookie(), origin: ORIGIN },
      reconnection: false,
    });
    sockets.push(socket);
    await once(socket, "connect");
    const closed = once(socket, "disconnect");
    const admin = await signIn("admin");
    assert.equal(
      (await admin.call("DELETE", `/memberships/${m.id}`)).status,
      200
    );
    const started = Date.now();
    await closed;
    assert.ok(Date.now() - started < 2000, "not after the 60 s recheck");
  });
});

describe("Idempotency-Key (E20)", () => {
  test("a retried create returns the first result instead of a duplicate", async () => {
    const a = await signIn("member");
    const key = { "Idempotency-Key": `create-${Date.now()}` };
    const first = await a.call("POST", "/dashboards", { name: "Once" }, key);
    const again = await a.call("POST", "/dashboards", { name: "Once" }, key);
    assert.equal(first.status, 201);
    assert.equal(again.status, 201);
    assert.equal(again.body.data.id, first.body.data.id);
    assert.equal(again.headers.get("idempotent-replayed"), "true");
    const { rowCount } = await owner.query(
      "SELECT 1 FROM dashboards WHERE team_id = $1 AND name = 'Once'",
      [team.id]
    );
    assert.equal(rowCount, 1);
    const reused = await a.call(
      "POST",
      "/dashboards",
      { name: "Different" },
      key
    );
    assert.equal(reused.status, 422, "same key, different request");
  });

  test("a key still running is 409; one abandoned by a crash is released", async () => {
    const a = await signIn("member");
    const insert = (key, age) =>
      owner.query(
        "INSERT INTO idempotency_keys (user_id, key, request_hash, created_at) VALUES ($1, $2, $3, now() - $4::interval)",
        [users.member, key, "x", age]
      );
    await insert("running-key", "1 second");
    assert.equal(
      (
        await a.call(
          "POST",
          "/dashboards",
          { name: "R" },
          { "Idempotency-Key": "running-key" }
        )
      ).status,
      422,
      "a different fingerprint is refused before anything else"
    );
    await owner.query(
      "UPDATE idempotency_keys SET request_hash = $2 WHERE key = $1",
      [
        "running-key",
        (await import("node:crypto"))
          .createHash("sha256")
          .update(`POST /dashboards ${JSON.stringify({ name: "R" })}`)
          .digest("base64url"),
      ]
    );
    assert.equal(
      (
        await a.call(
          "POST",
          "/dashboards",
          { name: "R" },
          { "Idempotency-Key": "running-key" }
        )
      ).status,
      409
    );
    await owner.query(
      "UPDATE idempotency_keys SET created_at = now() - interval '2 minutes' WHERE key = 'running-key'"
    );
    assert.equal(
      (
        await a.call(
          "POST",
          "/dashboards",
          { name: "R" },
          { "Idempotency-Key": "running-key" }
        )
      ).status,
      201,
      "a stale claim is taken over"
    );
  });
});

describe("audit: compressed archive, label index, chain across both (E19)", () => {
  test("old entries move into segments; listing, filters, scope and verify still work", async () => {
    const boss = await signIn("boss");
    const admin = await signIn("admin");
    for (let i = 0; i < 5; i++)
      await admin.call("POST", "/projects", { name: `arch-${i}` });
    await boss.call("POST", "/teams", { name: "Other team" });
    const all = async (client, query = "") => {
      const out = [];
      let before = "";
      for (;;) {
        const res = await client.call("GET", `/audit?limit=7${query}${before}`);
        assert.equal(res.status, 200);
        out.push(...res.body.data.entries);
        if (res.body.data.next_before === null) return out;
        before = `&before=${res.body.data.next_before}`;
      }
    };
    const beforeCompaction = await all(boss);

    const {
      rows: [{ n }],
    } = await owner.query(
      "SELECT app.compact_audit('-2 hours', 1000, $1) AS n",
      [org.id]
    );
    assert.ok(n >= 1, "segments written");
    const { rowCount: live } = await owner.query(
      "SELECT 1 FROM audit_log WHERE org_id = $1",
      [org.id]
    );
    assert.equal(
      live,
      1,
      "only the newest entry stays live (the chain continues from it)"
    );

    // Reading the log adds entries, so compare everything older than the first read.
    const afterCompaction = (await all(boss)).filter(
      (e) => e.seq <= beforeCompaction[0].seq
    );
    assert.deepEqual(
      afterCompaction.map((e) => [e.seq, e.action, e.actor_name]),
      beforeCompaction.map((e) => [e.seq, e.action, e.actor_name]),
      "the same entries, in the same order, across live rows and segments"
    );
    assert.ok(!("hash" in afterCompaction[1]), "chain internals stay internal");

    const projects = await all(boss, "&action=project.");
    assert.equal(
      projects.filter((e) => e.action === "project.create").length,
      5
    );
    const adminView = await all(admin);
    assert.ok(adminView.length > 0);
    assert.ok(
      adminView.every((e) => e.team_id === team.id),
      "an Admin sees only their team, also in the archive"
    );

    assert.equal(
      (await boss.call("GET", "/audit/verify")).body.data.intact,
      true
    );
    const storage = (await boss.call("GET", "/audit/storage")).body.data;
    assert.ok(storage.archived_entries >= beforeCompaction.length - 1);
    assert.ok(storage.segments >= 1);
  });

  test("an edited archived entry breaks the chain", async () => {
    const boss = await signIn("boss");
    const {
      rows: [segment],
    } = await owner.query(
      "SELECT id, entries->0->>'seq' AS seq, entries->0->>'action' AS action FROM audit_segments WHERE org_id = $1 ORDER BY id LIMIT 1",
      [org.id]
    );
    const edit = async (action) => {
      await owner.query(
        "ALTER TABLE audit_segments DISABLE TRIGGER audit_segments_append_only"
      );
      try {
        await owner.query(
          "UPDATE audit_segments SET entries = jsonb_set(entries, '{0,action}', to_jsonb($2::text)) WHERE id = $1",
          [segment.id, action]
        );
      } finally {
        await owner.query(
          "ALTER TABLE audit_segments ENABLE TRIGGER audit_segments_append_only"
        );
      }
    };
    await edit("tampered.entry");
    try {
      const result = (await boss.call("GET", "/audit/verify")).body.data;
      assert.equal(result.intact, false);
      assert.equal(result.first_broken, Number(segment.seq));
    } finally {
      await edit(segment.action);
    }
    assert.equal(
      (await boss.call("GET", "/audit/verify")).body.data.intact,
      true
    );
    await assert.rejects(
      owner.query("DELETE FROM audit_segments WHERE id = $1", [segment.id]),
      /append-only/
    );
  });

  test("denials are collapsed: one entry per user, path and status per minute (E5)", async () => {
    const member = await signIn("member");
    for (let i = 0; i < 5; i++)
      assert.equal((await member.call("GET", "/audit")).status, 403);
    await new Promise((resolve) => setTimeout(resolve, 300)); // denial writes aren't awaited
    const { rowCount } = await owner.query(
      "SELECT 1 FROM audit_log WHERE org_id = $1 AND action = 'access.denied' AND actor_id = $2",
      [org.id, users.member]
    );
    assert.equal(rowCount, 1);
  });
});

describe("housekeeping (E14, E17, E20)", () => {
  test("expired sessions, old deliveries and old idempotency keys are removed", async () => {
    await owner.query(
      "INSERT INTO sessions (token_hash, user_id, org_id, expires_at) VALUES (sha256('old-session'), $1, $2, now() - interval '1 minute')",
      [users.member, org.id]
    );
    await owner.query(
      "INSERT INTO idempotency_keys (user_id, key, request_hash, created_at) VALUES ($1, 'old-key', 'x', now() - interval '2 days')",
      [users.member]
    );
    const result = await runHousekeeping();
    assert.ok(result === null || result.sessions >= 1, JSON.stringify(result));
    const { rowCount: sessions } = await owner.query(
      "SELECT 1 FROM sessions WHERE token_hash = sha256('old-session')"
    );
    const { rowCount: keys } = await owner.query(
      "SELECT 1 FROM idempotency_keys WHERE key = 'old-key'"
    );
    if (result !== null) {
      assert.equal(sessions, 0);
      assert.equal(keys, 0);
    }
  });
});

describe("webhook worker limits (E15, E18)", () => {
  test("an endpoint that never answers fails within the deadline", async () => {
    const silent = http.createServer(() => {}); // accepts, never responds
    silent.listen(0, "127.0.0.1");
    await once(silent, "listening");
    try {
      const started = Date.now();
      const result = await send({
        url: `http://127.0.0.1:${silent.address().port}/`,
        event_id: "00000000-0000-4000-8000-000000000000",
        body: "{}",
        secret: "whsec_REDACTED",
      });
      assert.equal(result.ok, false);
      assert.match(result.error, /No response within 1.5 s/);
      assert.ok(Date.now() - started < 3000);
    } finally {
      silent.closeAllConnections();
      silent.close();
    }
  });

  test("production allows only web ports", () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      assert.throws(
        () => checkUrl("https://hooks.example.com:6379/"),
        /Port 6379/
      );
      assert.ok(checkUrl("https://hooks.example.com:8443/"));
      assert.ok(checkUrl("https://hooks.example.com/"));
    } finally {
      process.env.NODE_ENV = previous;
    }
  });
});

describe("request ids and names (E22, E25)", () => {
  test("every response carries a request id, and audit entries store it", async () => {
    const admin = await signIn("admin");
    const res = await admin.call(
      "POST",
      "/projects",
      { name: "with-id" },
      {
        "X-Request-Id": "trace-abc-12345",
      }
    );
    assert.equal(res.headers.get("x-request-id"), "trace-abc-12345");
    const { rows } = await owner.query(
      "SELECT meta->>'request_id' AS id FROM audit_log WHERE org_id = $1 AND action = 'project.create' ORDER BY seq DESC LIMIT 1",
      [org.id]
    );
    assert.equal(rows[0].id, "trace-abc-12345");
    const generated = await admin.call("GET", "/projects", undefined, {
      "X-Request-Id": "bad id!",
    });
    assert.match(
      generated.headers.get("x-request-id"),
      /^[0-9a-f-]{36}$/,
      "malformed ids are replaced"
    );
  });

  test("names made only of invisible characters are rejected", async () => {
    const admin = await signIn("admin");
    const res = await admin.call("POST", "/projects", { name: "​‍﻿" });
    assert.equal(res.status, 400);
  });
});

describe("signed audit checkpoints (problems-log #39)", () => {
  const verify = async () =>
    (await (await signIn("boss")).call("GET", "/audit/verify")).body.data;

  test("deleting the newest entries after a checkpoint is detected", async () => {
    const { writeCheckpoints } =
      await import("../src/utils/audit-checkpoints.js");
    const admin = await signIn("admin");
    await admin.call("GET", "/projects"); // nothing audited
    await admin.call("POST", "/projects", { name: `tail-${Date.now()}` });
    await writeCheckpoints(pool);
    const before = await verify();
    assert.equal(before.intact, true);
    assert.ok(before.checkpoints.latest_seq, "a checkpoint exists");

    // Remove the checkpointed entry and everything after it, as someone with DB access could.
    const { rows: tail } = await owner.query(
      // to_jsonb keeps microseconds and bytea exactly (a JS Date would drop the microseconds)
      "SELECT to_jsonb(a) AS row FROM audit_log a WHERE org_id = $1 AND seq >= $2 ORDER BY seq",
      [org.id, before.checkpoints.latest_seq]
    );
    await owner.query(
      "ALTER TABLE audit_log DISABLE TRIGGER audit_log_append_only"
    );
    try {
      await owner.query(
        "DELETE FROM audit_log WHERE org_id = $1 AND seq >= $2",
        [org.id, before.checkpoints.latest_seq]
      );
    } finally {
      await owner.query(
        "ALTER TABLE audit_log ENABLE TRIGGER audit_log_append_only"
      );
    }
    try {
      // Checked straight in the database: calling /audit/verify now would itself append an
      // entry onto the shortened chain (a permanent fork, which is the point of the evidence).
      const { checkCheckpoints } =
        await import("../src/utils/audit-checkpoints.js");
      const { withContext } = await import("../src/db/pool.js");
      const { chain, checkpoints } = await withContext(
        { userId: users.boss, orgId: org.id },
        async (db) => ({
          chain: (await db.query("SELECT * FROM app.audit_verify()")).rows[0],
          checkpoints: (
            await db.query("SELECT * FROM app.audit_checkpoint_status()")
          ).rows,
        })
      );
      assert.equal(
        chain.first_broken,
        null,
        "the shorter chain alone still verifies"
      );
      const problem = checkCheckpoints(org.id, checkpoints);
      assert.equal(problem.seq, before.checkpoints.latest_seq);
      assert.match(problem.reason, /missing/);
    } finally {
      for (const { row } of tail)
        await owner.query(
          `INSERT INTO audit_log SELECT * FROM jsonb_populate_record(NULL::audit_log, $1)`,
          [row]
        );
    }
    assert.equal(
      (await verify()).intact,
      true,
      "restoring the entries restores it"
    );
  });

  test("a forged checkpoint is detected (the key isn't in the database)", async () => {
    const {
      rows: [head],
    } = await owner.query(
      "SELECT seq, hash FROM audit_log WHERE org_id = $1 ORDER BY seq DESC LIMIT 1",
      [org.id]
    );
    await owner.query(
      "INSERT INTO audit_checkpoints (org_id, seq, hash, key_id, signature) VALUES ($1, $2, $3, (SELECT key_id FROM audit_checkpoints LIMIT 1), 'Zm9yZ2Vk') ON CONFLICT DO NOTHING",
      [org.id, head.seq, head.hash]
    );
    const result = await verify();
    assert.equal(result.intact, false);
    assert.match(result.reason, /signature/);
  });
});
