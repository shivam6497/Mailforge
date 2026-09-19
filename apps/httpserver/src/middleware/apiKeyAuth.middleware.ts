import { Request, Response, NextFunction } from "express";
import { prisma } from "@resend-clone/db";
import { verifyApiKey, extractPrefix } from "../lib/apiKey";

declare global {
  namespace Express {
    interface Request {
      apiKeyUserId?: string;
      apiKeyId?: string;
    }
  }
}

export async function requireApiKey(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const header = req.headers.authorization;

  if (!header || !header.startsWith("Bearer ")) {
    res.status(401).json({
      error: "Missing API key",
    });
    return;
  }

  const raw = header.slice(7);

  let prefix;
  try {
    prefix = extractPrefix(raw);
  } catch {
    res.status(401).json({
      error: "Malformed api key",
    });
    return;
  }

  const key = await prisma.apiKey.findUnique({
    where: { prefix },
  });

  if (!key || key.revokedAt !== null) {
    res.status(401).json({
      error: "Invalid or revoked api key",
    });
    return;
  }

  const valid = await verifyApiKey(raw, key.hash);
  if (!valid) {
    res.status(401).json({
      error: "Invalid api key",
    });
    return;
  }

  req.apiKeyUserId = key.userId;
  req.apiKeyId = key.id;
  next();
}
