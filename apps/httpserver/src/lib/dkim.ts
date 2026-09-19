import crypto from "crypto";
import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

export function generateDkimKeyPair(): {
  privateKey: String;
  publicKey: string;
} {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: {
      type: "spki",
      format: "pem",
    },
    privateKeyEncoding: {
      type: "pkcs8",
      format: "pem",
    },
  });

  return { privateKey, publicKey };
}

const ALGORITHM = "aes-256-gcm";

export function encryptPrivateKey(privateKey: string): string {
  const key = Buffer.from(process.env.DKIM_ENCRYPTION_KEY!, "hex");
  const iv = randomBytes(12);

  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(privateKey, "utf8"),
    cipher.final(),
  ]);

  const authTag = cipher.getAuthTag();

  return [
    iv.toString("base64"),
    authTag.toString("base64"),
    encrypted.toString("base64"),
  ].join(":");
}

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

export function publicKeyToDnsTxt(publicKey: string): string {
  return publicKey
    .replace("-----BEGIN PUBLIC KEY-----", "")
    .replace("-----END PUBLIC KEY-----", "")
    .replace(/\n/g, "");
}

export function buildDnsRecords(
  domain: string,
  verifyToken: string,
  publicKeyPem: string,
  selector: string = "resend",
) {
  const pubCleanKey = publicKeyToDnsTxt(publicKeyPem);

  return {
    ownership: {
      type: "TXT",
      name: `_resend-verify.${domain}`,
      value: verifyToken,
      purpose: "Proves you own this Domain",
    },
    dkim: {
      type: "TXT",
      name: `${selector}._domainkey.${domain}`,
      value: `v=DKIM1; k=rsa; p=${pubCleanKey}`,
      purpose: "Allows emails to be cryptographically signed",
    },
    spf: {
      type: "TXT",
      name: domain,
      value: "v=spf1 include:amazonses.com ~all",
      purpose: "Tells receiving servers your emails come from AWS SES",
    },
  };
}
