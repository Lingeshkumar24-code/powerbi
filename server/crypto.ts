import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Share and embed tokens are bearer credentials, so only their hash is used for
 * lookup. The plaintext also needs to be recoverable to redisplay a link later,
 * so it is sealed with a key that lives outside the database (env secret or a
 * 0600 file in the data directory).
 */
export function loadSecret(dataDir: string, envSecret?: string): Buffer {
  if (envSecret) return scryptSync(envSecret, "powerbicraft-link-key", 32);
  const file = join(dataDir, "secret.key");
  if (existsSync(file)) {
    const raw = readFileSync(file, "utf8").trim();
    const key = Buffer.from(raw, "base64url");
    if (key.length === 32) return key;
  }
  mkdirSync(dataDir, { recursive: true });
  const key = randomBytes(32);
  writeFileSync(file, key.toString("base64url"), { mode: 0o600 });
  return key;
}

export function seal(key: Buffer, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, ct].map((b) => b.toString("base64url")).join(".");
}

export function unseal(key: Buffer, sealed: string): string {
  const [ivB64, tagB64, ctB64] = sealed.split(".");
  if (!ivB64 || !tagB64 || !ctB64) throw new Error("malformed sealed payload");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64url"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(ctB64, "base64url")),
    decipher.final(),
  ]);
  return plain.toString("utf8");
}
