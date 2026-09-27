import { Job, Worker } from "bullmq";
import { QUEUE_NAMES, getRedis } from "@resend-clone/queue";
import { prisma } from "@resend-clone/db";
import type { EmailSendJobPayload } from "@resend-clone/types";
import nodemailer from "nodemailer";
import { SESClient, SendRawEmailCommand } from "@aws-sdk/client-ses";
import * as aws from "@aws-sdk/client-ses";
import { decryptPrivateKey } from "../lib/dkim";

const sesClient = new SESClient({
  region: process.env.AWS_REGION!,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  },
});

export function startEmailSendWorker() {
  const worker = new Worker<EmailSendJobPayload>(
    QUEUE_NAMES.EMAIL_SEND,
    async (job: Job<EmailSendJobPayload>) => {
      const { emailId } = job.data;

      const email = await prisma.email.findUnique({
        where: { id: emailId },
        include: {
          domain: true,
        },
      });

      if (!email) {
        return;
      }

      if (email.status === "DELIVERED") {
        return;
      }

      await prisma.email.update({
        where: { id: emailId },
        data: {
          status: "SENDING",
        },
      });

      try {
        await sendWithDkim(email);

        await prisma.email.update({
          where: { id: emailId },
          data: { status: "DELIVERED" },
        });

        console.log(`Email delivered: ${emailId}`);
      } catch (err) {
        await prisma.email.update({
          where: { id: emailId },
          data: {
            status: "FAILED",
            failReason: err instanceof Error ? err.message : "Unknown error",
          },
        });

        throw err;
      }
    },
    {
      connection: getRedis(),
      concurrency: 10,
    },
  );

  worker.on("failed", (job, err) => {
    if (!job) return;
    console.error(
      `Email permanently failed: ${job?.data.emailId}`,
      err.message,
    );
  });

  return worker;
}

async function sendWithDkim(email: {
  id: string;
  from: string;
  to: string[];
  subject: string;
  html: string | null;
  text: string | null;
  replyTo: string | null;
  domain: {
    domain: string;
    dkimPrivateKey: string;
    dkimPublicKey: string;
    dkimSelector: string;
  } | null;
}) {
  const privateKey = email.domain
    ? decryptPrivateKey(email.domain.dkimPrivateKey)
    : null;

  const transporter = nodemailer.createTransport({
    SES: {
      ses: sesClient,
      aws,
    },
    ...(privateKey && email.domain
      ? {
          dkim: {
            domainName: email.domain.domain,
            keySelector: email.domain.dkimSelector,
            privateKey,
          },
        }
      : {}),
  });

  await transporter.sendMail({
    from: email.from,
    to: email.to,
    subject: email.subject,
    html: email.html ?? undefined,
    text: email.text ?? undefined,
    replyTo: email.replyTo ?? undefined,
  });
}
