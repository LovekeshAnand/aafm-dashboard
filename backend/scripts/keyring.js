// Webhook-secret keyring management (Tier 3 C, Prompt 50).
//   npm run keyring -- init     create the keyring file with one new key
//   npm run keyring -- rotate   add a new current key and re-encrypt every stored secret
//   npm run keyring -- prune    drop keys no stored secret uses any more
// Runs as the database owner (MIGRATION_DATABASE_URL), like migrations.
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import pg from "pg";
import { keyIdOf, keyringFrom, open, seal } from "../src/utils/secret-box.js";

const file = process.env.WEBHOOK_KEYRING_FILE;
if (!file) throw new Error("WEBHOOK_KEYRING_FILE is not set (see .env.sample)");

const newKeyId = () =>
  `k${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}`;
const newKey = () => randomBytes(32).toString("base64");

// Write to a temp file, then rename: a crash never leaves a half-written keyring.
const save = (json) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, JSON.stringify(json, null, 2) + "\n", {
    mode: 0o600,
  });
  renameSync(`${file}.tmp`, file);
};
const read = () => JSON.parse(readFileSync(file, "utf8"));

const withOwner = async (work) => {
  const db = new pg.Client({
    connectionString: process.env.MIGRATION_DATABASE_URL,
  });
  await db.connect();
  try {
    return await work(db);
  } finally {
    await db.end();
  }
};

const commands = {
  init: async () => {
    if (existsSync(file)) throw new Error(`${file} already exists; use rotate`);
    const id = newKeyId();
    save({ current: id, keys: { [id]: newKey() } });
    console.log(`created ${file} with key ${id}`);
  },

  // The new key goes into the file first (still able to decrypt with the old ones), then every
  // secret is re-encrypted in one transaction. If anything fails, the database is unchanged and
  // both keys are still in the file, so nothing becomes unreadable.
  rotate: async () => {
    const json = read();
    const id = newKeyId();
    json.keys[id] = newKey();
    json.current = id;
    const ring = keyringFrom(json);
    save(json);
    const count = await withOwner(async (db) => {
      await db.query("BEGIN");
      const { rows } = await db.query(
        "SELECT id, secret, previous_secret FROM webhooks FOR UPDATE"
      );
      for (const row of rows) {
        const reseal = (value) =>
          value && seal(open(value, row.id, ring), row.id, ring);
        await db.query(
          "UPDATE webhooks SET secret = $2, previous_secret = $3 WHERE id = $1",
          [row.id, reseal(row.secret), reseal(row.previous_secret)]
        );
      }
      await db.query("COMMIT");
      return rows.length;
    });
    console.log(`current key is now ${id}; re-encrypted ${count} webhook(s)`);
  },

  prune: async () => {
    const json = read();
    const used = await withOwner(async (db) => {
      const { rows } = await db.query(
        "SELECT secret, previous_secret FROM webhooks"
      );
      return new Set(
        rows
          .flatMap((r) => [r.secret, r.previous_secret])
          .filter(Boolean)
          .map(keyIdOf)
      );
    });
    const removed = Object.keys(json.keys).filter(
      (id) => id !== json.current && !used.has(id)
    );
    for (const id of removed) delete json.keys[id];
    save(json);
    console.log(
      removed.length ? `removed ${removed.join(", ")}` : "nothing to remove"
    );
  },
};

const command = commands[process.argv[2]];
if (!command) {
  console.error("usage: npm run keyring -- init | rotate | prune");
  process.exitCode = 1;
} else {
  command().catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}
