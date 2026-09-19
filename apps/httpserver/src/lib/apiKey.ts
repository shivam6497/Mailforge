import crypto from "crypto";
import bcrypt from "bcryptjs";

export async function generateApiKey(): Promise<{
  raw: string;
  prefix: string;
  hash: string;
}> {
  const id = crypto.randomBytes(8).toString("hex");
  const secret = crypto.randomBytes(24).toString("hex");

  const prefix = `re_live_${id}`;
  const raw = `${prefix}_${secret}`;
  const hash = bcrypt.hashSync(raw, 10);

  return { raw, prefix, hash };
}

export async function hashApiKey(raw: string): Promise<string> {
  return bcrypt.hash(raw, 10);
}

export async function verifyApiKey(
  raw: string,
  hash: string,
): Promise<boolean> {
  return bcrypt.compare(raw, hash);
}

export function extractPrefix(raw: string): string {
  const parts = raw.split("_");

  return parts.slice(0, 3).join("_");
}
