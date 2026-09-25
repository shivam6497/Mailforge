import crypto from "crypto";
import { createDecipheriv } from "crypto";

const ALGORITHM = "aes-256-gcm";

export function decryptPrivateKey(stored: string): string {
  const key = Buffer.from(process.env.DKIM_ENCRYPTION_KEY!, "hex");
  const [ivB64, authTagB64, cipherB64] = stored.split(":");

  const iv = Buffer.from(ivB64!, "base64");
  const authTag = Buffer.from(authTagB64!, "base64");
  const cipher = Buffer.from(cipherB64!, "base64");

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  return Buffer.concat([decipher.update(cipher), decipher.final()]).toString(
    "utf8",
  );
}