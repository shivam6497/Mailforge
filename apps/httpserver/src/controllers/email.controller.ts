import { Request, Response } from "express";
import { prisma } from "@resend-clone/db";
import { Queue } from "bullmq";
import { QUEUE_NAMES, getRedis } from "@resend-clone/queue";
import type { EmailSendJobPayload } from "@resend-clone/types";
import { z } from "zod";

const emailSendQueue = new Queue<EmailSendJobPayload>(QUEUE_NAMES.EMAIL_SEND, {
  connection: getRedis(),
});

const sendEmailSchema = z
  .object({
    from: z.string().email("Must be a valid email address"),
    to: z
      .union([z.string().email(), z.array(z.string().email()).min(1)])
      .transform((val) => (Array.isArray(val) ? val : [val])),
    subject: z.string().min(1).max(998),
    html: z.string().optional(),
    text: z.string().optional(),
    replyTo: z.string().email().optional(),
  })
  .refine((data) => data.html || data.text, {
    message: "At least one of html or text is required",
  });

export async function sendEmail(req: Request, res: Response): Promise<void> {
  try {
    const result = sendEmailSchema.safeParse(req.body);
    if (!result.success) {
      res.status(400).json({
        error: result.error.flatten(),
      });
      return;
    }

    const { from, to, subject, html, text, replyTo } = result.data;
    const userId = req.apiKeyUserId;
    if (!userId) {
      res.status(403).json({
        error: "Forbidden: Invalid API key",
      });
      return;
    }

    const fromDomain = from.split("@")[1];

    const domain = await prisma.domain.findFirst({
      where: {
        domain: fromDomain,
        userId: userId,
        status: "VERIFIED",
      },
    });

    if (!domain) {
      res.status(403).json({
        error:
          `Domain ${fromDomain} is not verified. ` +
          `Add and verify it at /api/domains before sending.`,
      });
      return;
    }

    const email = await prisma.email.create({
      data: {
        userId: userId,
        domainId: domain.id,
        from,
        to,
        subject,
        html,
        text,
        replyTo,
        status: "QUEUED",
      },
      select: {
        id: true,
        from: true,
        to: true,
        subject: true,
        status: true,
        createdAt: true,
      },
    });

    await emailSendQueue.add(
      "email-send",
      { emailId: email.id },
      {
        attempts: 3,
        backoff: {
          type: "exponential",
          delay: 5 * 1000,
        },
        removeOnComplete: 1000,
        removeOnFail: 5000,
      },
    );

    res.status(202).json(email);
  } catch (error) {
    console.error("Failed to send email:", error);
    res.status(500).json({
      error: "Internal server error",
    });
  }
}

export async function getEmail(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const userId = req.apiKeyUserId ?? req.user?.userId;

    const email = await prisma.email.findFirst({
      where: { id, userId },
      select: {
        id: true,
        from: true,
        to: true,
        subject: true,
        status: true,
        failReason: true,
        sentAt: true,
        createdAt: true,
        domain: {
          select: { domain: true, status: true },
        },
      },
    });

    if (!email) {
      res.status(404).json({
        error: "Email not found",
      });
      return;
    }

    res.status(200).json(email);
  } catch (error) {
    console.error("Failed to get email:", error);
    res.status(500).json({
      error: "Internal server error",
    });
  }
}

export async function listEmails(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user?.userId;
    const cursor = req.query.cursor as string | undefined;
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    const status = req.query.status as string | undefined;

    const emails = await prisma.email.findMany({
      where: {
        userId,
        ...(status && { status: status as any }),
      },
      select: {
        id: true,
        from: true,
        to: true,
        subject: true,
        status: true,
        sentAt: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
      take: limit + 1, 
      ...(cursor && {
        cursor: { id: cursor },
        skip: 1, 
      }),
    });

    const hasNextPage = emails.length > limit;
    const items = hasNextPage ? emails.slice(0, limit) : emails;
    const nextCursor = hasNextPage ? items[items.length - 1]!.id : null;

    res.json({
      emails: items,
      pagination: {
        nextCursor,
        hasNextPage,
      },
    });
  } catch (err) {
    console.error("Failed to list emails:", err);
    res.status(500).json({
      error: "Internal server error",
    });
  }
}
