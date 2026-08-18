import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const deriveKey = promisify(scrypt);
const KEY_LENGTH = 64;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const digest = await deriveKey(password, salt, KEY_LENGTH) as Buffer;
  return `${salt.toString("hex")}:${digest.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltHex, digestHex] = stored.split(":");
  if (!saltHex || !digestHex) return false;
  const expected = Buffer.from(digestHex, "hex");
  const actual = await deriveKey(
    password,
    Buffer.from(saltHex, "hex"),
    expected.length,
  ) as Buffer;
  return actual.length === expected.length && timingSafeEqual(expected, actual);
}
