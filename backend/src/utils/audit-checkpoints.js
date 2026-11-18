import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { keyring } from "./secret-box.js";

// Problems-log #39: signed audit checkpoints (migration 013). The signing key is derived (HKDF)
// from the keyring file's key, so it lives outside the database like the webhook secrets'
// key, and a key rotation keeps old checkpoints verifiable (each names its key id).
const signingKey = (ring, keyId) =>
  Buffer.from(
    hkdfSync(
      "sha256",
      ring.keys[keyId],
      Buffer.alloc(0),
      "aafm-audit-checkpoint-v1",
      32
    )
  );

const sign = (orgId, seq, hash, ring, keyId) =>
  createHmac("sha256", signingKey(ring, keyId))
    .update(`${orgId}|${seq}|${Buffer.from(hash).toString("hex")}`)
    .digest("base64");

/** Housekeeping: sign and store each org's newest entry that has no checkpoint yet. */
const writeCheckpoints = async (pool, ring = keyring()) => {
  const { rows } = await pool.query(
    "SELECT * FROM app.audit_heads_to_checkpoint()"
  );
  for (const { org_id, seq, hash } of rows)
    await pool.query("SELECT app.add_audit_checkpoint($1, $2, $3, $4, $5)", [
      org_id,
      seq,
      hash,
      ring.current,
      sign(org_id, seq, hash, ring, ring.current),
    ]);
  return rows.length;
};

/**
 * Verify: every checkpoint must carry a valid signature (not forged or edited) and its entry
 * must still exist with the same hash (not deleted). Returns the first problem, newest first.
 */
const checkCheckpoints = (orgId, rows, ring = keyring()) => {
  for (const row of rows) {
    const seq = Number(row.seq);
    if (!ring.keys[row.key_id])
      return {
        seq,
        reason: `signed with key "${row.key_id}", which is not in the keyring`,
      };
    const expected = Buffer.from(
      sign(orgId, row.seq, row.hash, ring, row.key_id)
    );
    const actual = Buffer.from(row.signature);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      return {
        seq,
        reason: "the checkpoint's signature doesn't match (forged or edited)",
      };
    if (!row.present)
      return {
        seq,
        reason: "this signed entry is missing: entries were deleted",
      };
  }
  return null;
};

export { checkCheckpoints, sign, writeCheckpoints };
