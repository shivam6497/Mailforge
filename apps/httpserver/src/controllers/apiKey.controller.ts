import { Request, Response } from "express";
import { prisma } from "@resend-clone/db";
import { generateApiKey, extractPrefix, verifyApiKey } from "../lib/apiKey";
import { z } from "zod";

const createSchema = z.object({
  name: z.string().min(3).max(64),
});

export async function createApiKey(req: Request, res: Response): Promise<void> {
  try {
    const result = createSchema.safeParse(req.body);
    if (!result.success) {
      res.status(400).json({
        error: result.error.flatten(),
      });
      return;
    }

    const { name } = result.data;
    const { raw, prefix, hash } = await generateApiKey();

    await prisma.apiKey.create({
      data: {
        name,
        prefix,
        hash,
        userId: req.user!.userId,
      },
    });

    res.status(201).json({
      key: raw,
      prefix,
      name,
    });
  } catch (error) {
    res.status(500).json({ error: "Internal Server Error" });
  }
}

export async function listApiKeys(req: Request, res: Response) {
  try {
    const keys = await prisma.apiKey.findMany({
      where: {
        userId: req.user!.userId,
        revokedAt: null,
      },
      select: {
        id: true,
        name: true,
        prefix: true,
        createdAt: true,
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    res.status(200).json({
      keys,
    });
  } catch (error) {
    res.status(500).json({ error: "Internal server error" });
  }
}

export async function revokeApiKey(req: Request, res: Response) {
  try {
    const { id } = req.params;

    const key = await prisma.apiKey.findFirst({
      where: {
        id,
        userId: req.user!.userId,
        revokedAt: null,
      },
    });

    if (!key) {
      res.status(404).json({
        error: "API key not found",
      });
      return;
    }

    await prisma.apiKey.update({
      where: { id },
      data: { revokedAt: new Date() },
    });

    res.status(200).json({
      ok: true,
    });
  } catch (error) {
    res.status(500).json({ error: "Internal server error" });
  }
}
