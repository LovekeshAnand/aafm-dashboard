import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

// Tier 3 C (Prompt 50): webhook signing secrets are encrypted at rest.
// OWASP Cryptographic Storage Cheat Sheet: an authenticated mode (AES-256-GCM), keys stored
// apart from the data they protect (a keyring file, never the database or the repo), and a
// rotation path built in from the start (each ciphertext names its key).
//
// Keyring file (path in WEBHOOK_KEYRING_FILE, created by `npm run keyring -- init`):
//   { "current": "k1", "keys": { "k1": "<32 random bytes, base64>" } }
// Sealed value: "v1:<key id>:<iv>:<auth tag>:<ciphertext>" (base64 parts). The webhook's id is
// bound in as additional authenticated data, so a ciphertext copied onto another webhook row
// fails to decrypt instead of signing for the wrong endpoint.
// ponytail: a keyring file is the self-hosted step; envelope encryption with a cloud KMS
// (the KMS holds the key-encryption key) is the upgrade for a managed deployment.

const KEY_ID = /^[A-Za-z0-9_-]{1,32}$/;

/** Validates a parsed keyring; throws with a clear message instead of failing later. */
const keyringFrom = (json) => {
  const { current, keys } = json ?? {};
  if (!keys || typeof keys !== "object" || !KEY_ID.test(current ?? ""))
    throw new Error('keyring needs { "current": "<id>", "keys": { ... } }');
  const ring = { current, keys: {} };
  for (const [id, value] of Object.entries(keys)) {
    const key = Buffer.from(String(value), "base64");
    if (!KEY_ID.test(id) || key.length !== 32)
      throw new Error(`keyring key "${id}" must be 32 bytes, base64`);
    ring.keys[id] = key;
  }
  if (!ring.keys[current])
    throw new Error(`keyring current key "${current}" is missing`);
  return ring;
};

let loaded;
/** The keyring from WEBHOOK_KEYRING_FILE, read once. */
const keyring = () => {
  if (loaded) return loaded;
  const file = process.env.WEBHOOK_KEYRING_FILE;
  if (!file)
    throw new Error(
      "WEBHOOK_KEYRING_FILE is not set (run `npm run keyring -- init`)"
    );
  loaded = keyringFrom(JSON.parse(readFileSync(file, "utf8")));
  return loaded;
};

const seal = (plaintext, aad, ring = keyring()) => {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", ring.keys[ring.current], iv);
  cipher.setAAD(Buffer.from(aad));
  const data = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  return [
    "v1",
    ring.current,
    iv.toString("base64"),
    cipher.getAuthTag().toString("base64"),
    data.toString("base64"),
  ].join(":");
};

const open = (sealed, aad, ring = keyring()) => {
  const [version, keyId, iv, tag, data] = String(sealed).split(":");
  if (version !== "v1" || data === undefined)
    throw new Error("Secret is not in the sealed v1 format");
  const key = ring.keys[keyId];
  if (!key) throw new Error(`Encryption key "${keyId}" is not in the keyring`);
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(iv, "base64")
  );
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(data, "base64")),
    decipher.final(), // throws if the ciphertext, tag, key or webhook id don't match
  ]).toString("utf8");
};

/** The key id a sealed value was written with (for re-encryption after a rotation). */
const keyIdOf = (sealed) => String(sealed).split(":")[1];

export { keyIdOf, keyring, keyringFrom, open, seal };
