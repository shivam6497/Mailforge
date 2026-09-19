import { Request, Response, NextFunction } from "express";
import { verifyAccessToken } from "../lib/jwt";

declare global {
  namespace Express {
    interface Request {
      user?: { userId: string; email: string };
    }
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = req.cookies?.access_token;

  if (!token) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    req.user = verifyAccessToken(token);
    next();
  } catch {
    res.status(401).json({ error: "Expired or Invalid token" });
  }
}
