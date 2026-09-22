import { Request, Response } from "express";
import bcrypt from "bcryptjs";
import { prisma } from "@resend-clone/db";
import {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
} from "../lib/jwt";
import { z } from "zod";
import { getRedis } from "@resend-clone/queue";
import { email } from "zod/v4";

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
};

export async function register(req: Request, res: Response): Promise<void> {
  try {
    const result = registerSchema.safeParse(req.body);
    if (!result.success) {
      res.status(400).json({
        error: result.error.flatten(),
      });
      return;
    }

    const { email, password } = result.data;

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      res.status(409).json({
        message: "Email already in use",
      });
      return;
    }

    const hash = await bcrypt.hash(password, 12);
    const user = await prisma.user.create({
      data: { email, password: hash },
      select: { id: true, email: true, createdAt: true },
    });

    const payload = { userId: user.id, email: user.email };
    const accessToken = signAccessToken(payload);
    const refreshToken = signRefreshToken(payload);

    const redis = getRedis();
    await redis.setex(`refresh:${user.id}`, 7 * 24 * 60 * 60, refreshToken);

    res
      .cookie("access_token", accessToken, {
        ...COOKIE_OPTIONS,
        maxAge: 15 * 60 * 1000,
      })
      .cookie("refresh_token", refreshToken, {
        ...COOKIE_OPTIONS,
        maxAge: 7 * 24 * 60 * 60 * 1000,
        path: "/auth/refresh",
      })
      .status(201)
      .json({ user });
  } catch (error) {
    res.status(500).json({ error: "Internal server error" });
  }
}

export async function login(req: Request, res: Response): Promise<void> {
  try {
    const result = loginSchema.safeParse(req.body);
    if (!result.success) {
      res.status(400).json({ error: result.error.flatten() });
      return;
    }

    const { email, password } = result.data;
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      res.status(401).json({
        error: "Invalid Credentials",
      });
      return;
    }

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      res.status(401).json({ error: "Invalid Credentials" });
      return;
    }

    const payload = { userId: user.id, email: user.email };
    const accessToken = signAccessToken(payload);
    const refreshToken = signRefreshToken(payload);

    const redis = getRedis();
    await redis.setex(`refresh:${user.id}`, 7 * 24 * 60 * 60, refreshToken);

    res
      .cookie("access_token", accessToken, {
        ...COOKIE_OPTIONS,
        maxAge: 15 * 60 * 1000,
      })
      .cookie("refresh_token", refreshToken, {
        ...COOKIE_OPTIONS,
        maxAge: 7 * 24 * 60 * 60 * 1000,
        path: "/auth/refresh",
      })
      .status(200)
      .json({
        user: { id: user.id, email: user.email, createdAt: user.createdAt },
      });
  } catch (error) {
    res.status(500).json({ error: "Internal server error" });
  }
}

export async function refresh(req: Request, res: Response): Promise<void> {
  try {
    const token = req.cookies?.refresh_token;
    if (!token) {
      res.status(401).json({
        error: "No refresh Token",
      });
      return;
    }

    let payload;
    try {
      payload = verifyRefreshToken(token);
    } catch {
      res.status(401).json({ error: "Invalid refresh token" });
      return;
    }

    const redis = getRedis();
    const stored = await redis.get(`refresh:${payload.userId}`);

    if (stored !== token) {
      await redis.del(`refresh:${payload.userId}`);
      res.status(401).json({ error: "Refresh token reuse detected" });
      return;
    }

    const newPayload = { userId: payload.userId, email: payload.email };
    const newAccessToken = signAccessToken(newPayload);
    const newRefreshToken = signRefreshToken(newPayload);

    await redis.setex(
      `refresh:${newPayload.userId}`,
      7 * 24 * 60 * 60,
      newRefreshToken,
    );

    res
      .cookie("access_token", newAccessToken, {
        ...COOKIE_OPTIONS,
        maxAge: 15 * 60 * 1000,
      })
      .cookie("refresh_token", newRefreshToken, {
        ...COOKIE_OPTIONS,
        maxAge: 7 * 24 * 60 * 60 * 1000,
        path: "/auth/refresh",
      })
      .json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: "Internal server error" });
  }
}

export async function logout(req: Request, res: Response): Promise<void> {
  try {
    const token = req.cookies?.refresh_token;
    if (token) {
      try {
        const payload = verifyRefreshToken(token);
        const redis = getRedis();
        await redis.del(`refresh:${payload.userId}`);
      } catch {}
    }

    res
      .clearCookie("access_token")
      .clearCookie("refresh_token", { path: "/auth/refresh" })
      .json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: "Internal server error" });
  }
}
