import { Request, Response } from "express";
import { prisma } from "@resend-clone/db";
import { randomUUID } from "crypto";
import { Queue } from "bullmq";
import { getRedis, QUEUE_NAMES } from "@resend-clone/queue";
import type { DomainVerifyJobPayload } from "@resend-clone/types";
import { SESv2Client, CreateEmailIdentityCommand } from "@aws-sdk/client-sesv2";
import {
  generateDkimKeyPair,
  buildDnsRecords,
  encryptPrivateKey,
} from "../lib/dkim";
import { z } from "zod";

const domainVerifyQueue = new Queue<DomainVerifyJobPayload>(
  QUEUE_NAMES.DOMAIN_VERIFY,
  { connection: getRedis() },
);

const sesV2 = new SESv2Client({ region: process.env.AWS_REGION });

const addDomainSchema = z.object({
  domain: z
    .string()
    .min(1)
    .regex(
      /^([a-z0-9]+(-[a-z0-9]+)*\.)+[a-z]{2,}$/,
      "Must be a valid domain like example.com",
    ),
});

export async function addDomains(req: Request, res: Response): Promise<void> {
  try {
    const result = addDomainSchema.safeParse(req.body);
    if (!result.success) {
      res.status(400).json({
        error: result.error.flatten(),
      });
      return;
    }

    const { domain } = result.data;

    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const existing = await prisma.domain.findUnique({ where: { domain } });
    if (existing) {
      res.status(400).json({
        error: "Domain already exists",
      });
      return;
    }

    const sesResponse = await sesV2.send(
      new CreateEmailIdentityCommand({
        EmailIdentity: domain,
        DkimSigningAttributes: {
          NextSigningKeyLength: "RSA_2048_BIT",
        },
      }),
    );

    const sesDkimRecords = sesResponse.DkimAttributes?.Tokens?.map((token) => ({
      type: "CNAME",
      name: `${token}._domainkey.${domain}`,
      value: `${token}.dkim.amazonses.com`,
    }));


    const { privateKey, publicKey } = generateDkimKeyPair();
    const encryptedKey = encryptPrivateKey(privateKey as string);
    const verifyToken = `resend-verify=${randomUUID()}`;

    const newDomain = await prisma.domain.create({
      data: {
        domain,
        userId,
        verifyToken,
        dkimPrivateKey: encryptedKey,
        dkimPublicKey: publicKey,
        dkimSelector: "resend",
      },
    });

    await domainVerifyQueue.add(
      "verify-domain",
      { domainId: newDomain.id },
      {
        attempts: 576,
        backoff: {
          type: "fixed",
          delay: 5 * 60 * 1000,
        },
      },
    );

    const buildRecords = buildDnsRecords(domain, verifyToken, publicKey);

    res.status(201).json({
      domain: {
        id: newDomain.id,
        domain: newDomain.domain,
        status: newDomain.status,
        createdAt: newDomain.createdAt,
      },
      buildRecords,
      sesDkim: sesDkimRecords,
    });
  } catch (error) {
    res.status(500).json({
      error: "Internal server error",
    });
  }
}

export async function listDomains(req: Request, res: Response): Promise<void> {
  try {
    const domains = await prisma.domain.findMany({
      where: { userId: req.user?.userId },
      select: {
        id: true,
        domain: true,
        status: true,
        verifiedAt: true,
        dkimSelector: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
    });

    res.status(200).json({ domains });
  } catch (error) {
    console.log(error);
    res.status(500).json({ error: "Internal server error" });
  }
}

export async function getDomain(req: Request, res: Response) {
  try {
    const { id } = req.params;

    const domain = await prisma.domain.findFirst({
      where: {
        id,
        userId: req.user?.userId,
      },
      select: {
        id: true,
        domain: true,
        status: true,
        verifyToken: true,
        dkimPublicKey: true,
        dkimSelector: true,
        verifiedAt: true,
        createdAt: true,
      },
    });

    if (!domain) {
      res.status(404).json({
        error: "Domain not found",
      });
      return;
    }

    const dnsRecords = buildDnsRecords(
      domain.domain,
      domain.verifyToken,
      domain.dkimPublicKey,
      domain.dkimSelector,
    );

    res.status(200).json({ domain, dnsRecords });
  } catch (error) {
    console.log(error);
    res.status(500).json({ error: "Internal server error" });
  }
}

export async function deleteDomain(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;

    const domain = await prisma.domain.findFirst({
      where: { id, userId: req.user?.userId },
    });

    if (!domain) {
      res.status(404).json({
        error: "Domain not found",
      });
      return;
    }

    await prisma.domain.delete({ where: { id } });
    res.status(200).json({ ok: true });
  } catch (error) {
    console.log(error);
    res.status(500).json({ error: "Internal server error" });
  }
}
