import { Queue, Worker, QueueOptions } from "bullmq";
import Redis from "ioredis";

let redisInstanse: Redis | null = null;

export function getRedis(): Redis {
    if(!redisInstanse) {
        redisInstanse = new Redis(process.env.REDIS_URL!, {
            maxRetriesPerRequest: null,
        });
        return redisInstanse;
    }
    return redisInstanse;
}

export const defaultQueueOptions: QueueOptions = {
    connection: getRedis(),
}

export const QUEUE_NAMES = {
    EMAIL_SEND: "email-send",
    DOMAIN_VERIFY: "domain-verify"
} as const;

export { Queue, Worker };
export type { QueueOptions };