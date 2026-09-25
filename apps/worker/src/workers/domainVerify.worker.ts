import { Job, Worker } from "bullmq";
import { QUEUE_NAMES, getRedis } from "@resend-clone/queue";
import type { DomainVerifyJobPayload } from "@resend-clone/types";
import { prisma } from "@resend-clone/db";
import dns from "dns/promises";
import { SESv2Client, GetEmailIdentityCommand } from "@aws-sdk/client-sesv2";

const sesV2 = new SESv2Client({ region: process.env.AWS_REGION! });

async function checkDnsRecords(
  domain: string,
  verifyToken: string,
  publicKeyPem: string,
  selector: string,
): Promise<{ ownership: boolean; dkim: boolean }> {
  const pubKeyClean = publicKeyPem
    .replace("-----BEGIN PUBLIC KEY-----", "")
    .replace("-----END PUBLIC KEY-----", "")
    .replace(/\n/g, "");

  let ownership = false;
  let dkim = false;

  try {
    const records = await dns.resolveTxt(`_resend-verify.${domain}`);
    const flat = records.map((r) => r.join(""));
    ownership = flat.includes(verifyToken);
  } catch {
    ownership = false;
  }

  try {
    const records = await dns.resolveTxt(`${selector}._domainkey.${domain}`);
    const flat = records.map((r) => r.join(""));
    dkim = flat.some((r) => r.includes(`p=${pubKeyClean}`));
  } catch {
    dkim = false;
  }

  return { ownership, dkim };
}

async function checkVerification(
  domain: string,
  verifyToken: string,
  publicKeyPem: string,
  selector: string,
): Promise<{ ownership: boolean; dkim: boolean; sesVerified: boolean }> {
  const { ownership, dkim } = await checkDnsRecords(
    domain,
    verifyToken,
    publicKeyPem,
    selector,
  );

  let sesVerified = false;
  try {
    const identity = await sesV2.send(
      new GetEmailIdentityCommand({ EmailIdentity: domain }),
    );

    sesVerified = identity.VerifiedForSendingStatus === true;
  } catch {
    sesVerified = false;
  }

  return { ownership, dkim, sesVerified };
}

export function startDomainVerifyWorker() {
  const worker = new Worker<DomainVerifyJobPayload>(
    QUEUE_NAMES.DOMAIN_VERIFY,
    async (job: Job<DomainVerifyJobPayload>) => {
      const { domainId } = job.data;

      const domain = await prisma.domain.findUnique({
        where: {
          id: domainId,
        },
      });

      if (!domain) {
        return;
      }

      if (domain.status === "VERIFIED") {
        return;
      }

      const { ownership, dkim, sesVerified } = await checkVerification(
        domain.domain,
        domain.verifyToken,
        domain.dkimPublicKey,
        domain.dkimSelector,
      );

      if (ownership && dkim && sesVerified) {
        await prisma.domain.update({
          where: { id: domainId },
          data: {
            status: "VERIFIED",
            verifiedAt: new Date(),
          },
        });
        return;
      }
      throw new Error(
        `DNS records not yet found for ${domain.domain} — ` +
          `ownership: ${ownership}, dkim: ${dkim}`,
      );
    },
    {
      connection: getRedis(),
      concurrency: 5,
    },
  );

  worker.on("failed", async (job, err) => {
    if (!job) return;

    if (job.attemptsMade >= (job.opts.attempts ?? 1)) {
      await prisma.domain.update({
        where: { id: job.data.domainId },
        data: { status: "FAILED", failedAt: new Date() },
      });

      console.log(`Domain verification timed out: ${job.data.domainId}`);
    }
  });

  return worker;
}
