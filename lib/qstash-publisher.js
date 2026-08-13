import { validateSquareWebhookQueueMessage } from "./square-webhook-message.js";

export const APPROVED_QSTASH_URL = "https://qstash-us-east-1.upstash.io";
export const QSTASH_PUBLISH_TIMEOUT_MS = 2500;
export const QSTASH_DESTINATION_TIMEOUT = "30s";
export const QSTASH_RETRIES = 5;

let testPublisher = null;

function configuredPublisher() {
  const qstashUrl = process.env.QSTASH_URL;
  const token = process.env.QSTASH_TOKEN;
  const workerUrl = process.env.QSTASH_WORKER_URL;
  const bypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  if (!qstashUrl || !token || !workerUrl || !bypassSecret) return null;
  return new QStashHttpPublisher({ qstashUrl, token, workerUrl, bypassSecret });
}

export function validQStashUrl(value) {
  try {
    const url = new URL(value);
    return (
      url.origin === APPROVED_QSTASH_URL &&
      url.href === APPROVED_QSTASH_URL + "/" &&
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      (url.pathname === "/" || url.pathname === "")
    );
  } catch {
    return false;
  }
}

export function validWorkerUrl(value) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === "/api/square/webhook-worker"
    );
  } catch {
    return false;
  }
}

export function getQStashPublisher() {
  if (testPublisher) return testPublisher;
  return configuredPublisher();
}

export function setQStashPublisherForTests(publisher) {
  testPublisher = publisher;
}

export function resetQStashPublisherForTests() {
  testPublisher = null;
}

export class QStashHttpPublisher {
  constructor({ qstashUrl, token, workerUrl, bypassSecret, fetchImpl = fetch }) {
    this.qstashUrl = qstashUrl;
    this.token = token;
    this.workerUrl = workerUrl;
    this.bypassSecret = bypassSecret;
    this.fetchImpl = fetchImpl;
  }

  async publishSquareWebhook(message) {
    validateSquareWebhookQueueMessage(message);
    if (
      !this.qstashUrl ||
      !this.token ||
      !this.workerUrl ||
      !this.bypassSecret ||
      !validQStashUrl(this.qstashUrl) ||
      !validWorkerUrl(this.workerUrl)
    ) {
      throw new Error("qstash_not_configured");
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), QSTASH_PUBLISH_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(
        `${APPROVED_QSTASH_URL}/v2/publish/${encodeURIComponent(this.workerUrl)}`,
        {
          method: "POST",
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${this.token}`,
            "Content-Type": "application/json",
            "Upstash-Deduplication-Id": message.eventId,
            "Upstash-Retries": String(QSTASH_RETRIES),
            "Upstash-Timeout": QSTASH_DESTINATION_TIMEOUT,
            "Upstash-Forward-x-vercel-protection-bypass": this.bypassSecret,
            "Upstash-Redact-Fields": "body, header[x-vercel-protection-bypass]",
          },
          body: JSON.stringify(message),
        },
      );
      if (!response.ok) throw new Error("qstash_publish_failed");
      return await response.json();
    } finally {
      clearTimeout(timeout);
    }
  }
}

export const qstashPublisherTestInternals = {
  APPROVED_QSTASH_URL,
  validQStashUrl,
  validWorkerUrl,
};
