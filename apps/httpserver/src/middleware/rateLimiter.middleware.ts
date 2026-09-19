import { Request, Response, NextFunction } from "express";
import { getRedis } from "@resend-clone/queue";

const MAX_TOKENS = 100;
const REFILL_RATE = 10;
const TTL = 3600;

const redis = getRedis();

export async function tokenBucketLimiter(apiKeyId: string): Promise<boolean> {
  const key = `ratelimit:email:${apiKeyId}`;
  const now = Date.now() / 1000;

  const data = await redis.hgetall(key);
  let tokens: number;
  let lastRefill: number;

  if (!data || !data.tokens) {
    tokens = MAX_TOKENS;
    lastRefill = now;
  } else {
    tokens = parseFloat(data.tokens);
    lastRefill = parseFloat(data.lastRefill ?? String(now));
    const elapsed = now - lastRefill;
    tokens = Math.min(MAX_TOKENS, tokens + elapsed * REFILL_RATE);
    lastRefill = now;
  }

  if (tokens < 1) {
    await redis.hset(key, { tokens, lastRefill });
    await redis.expire(key, TTL);
    return false;
  }

  tokens -= 1;
  await redis.hset(key, { tokens, lastRefill });
  await redis.expire(key, TTL);
  return true;
}

export async function rateLimitByApiKey(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const apiKeyId = req.apiKeyId;
  if (!apiKeyId) {
    next();
    return;
  }

  const allowed = await tokenBucketLimiter(apiKeyId);
  if (!allowed) {
    res.status(429).json({
      error: "Rate limit exceeded. Max 100 emails per 10 seconds.",
    });
    return;
  }

  next();
}
