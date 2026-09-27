import { startDomainVerifyWorker } from "./workers/domainVerify.worker";
import { startEmailSendWorker } from "./workers/emailSend.worker";

const domainVerifyWorker = startDomainVerifyWorker();
const emailSendWorker = startEmailSendWorker();

console.log("Workers started — email-send + domain-verify");

process.on("SIGTERM", async () => {
  await Promise.all([emailSendWorker.close(), domainVerifyWorker.close()]);
  process.exit(0);
});
