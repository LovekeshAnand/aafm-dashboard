import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);

// OWASP Password Storage Cheat Sheet minimum for scrypt: N=2^17, r=8, p=1.
// maxmem must exceed 128 * N * r bytes (128 MiB here).
const PARAMS = { N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
const KEY_LENGTH = 64;

/** Returns "scrypt$<salt b64>$<key b64>". */
const hashPassword = async (password) => {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, KEY_LENGTH, PARAMS);
  return `scrypt$${salt.toString("base64")}$${key.toString("base64")}`;
};

/** Constant-time comparison; malformed hashes simply fail. */
const verifyPassword = async (password, storedHash) => {
  const [algorithm, salt, key] = String(storedHash).split("$");
  if (algorithm !== "scrypt" || !salt || !key) return false;

  const expected = Buffer.from(key, "base64");
  const actual = await scrypt(
    password,
    Buffer.from(salt, "base64"),
    expected.length,
    PARAMS
  );
  return timingSafeEqual(actual, expected);
};

export { hashPassword, verifyPassword };
