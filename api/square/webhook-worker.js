import { Receiver } from "@upstash/qstash";
import { readRawBody } from "../../lib/read-raw-body.js";
import { reconcileSquareWebhookMessage } from "../../lib/square-webhook-reconcile.js";
import {
  SquareWebhookMessageError,
  validateSquareWebhookQueueMessage,
} from "../../lib/square-webhook-message.js";

let testReceiver = null;

function getHeader(req, name) {
  const value = req.headers[name] || req.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function configuredReceiver() {
  const currentSigningKey = process.env.QSTASH_CURRENT_SIGNING_KEY;
  const nextSigningKey = process.env.QSTASH_NEXT_SIGNING_KEY;
  const workerUrl = process.env.QSTASH_WORKER_URL;
  if (!currentSigningKey || !nextSigningKey || !workerUrl) return null;
  return {
    workerUrl,
    verify: ({ body, signature, upstashRegion }) =>
      new Receiver({ currentSigningKey, nextSigningKey }).verify({
        body,
        signature,
        url: workerUrl,
        upstashRegion,
      }),
  };
}

function getReceiver() {
  return testReceiver || configuredReceiver();
}

export function setQStashReceiverForTests(receiver) {
  testReceiver = receiver;
}

export function resetQStashReceiverForTests() {
  testReceiver = null;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const rawBody = await readRawBody(req);
  if (!rawBody) {
    return res.status(400).json({ error: "Could not read the raw request body." });
  }

  const receiver = getReceiver();
  const signature = getHeader(req, "upstash-signature");
  if (!receiver || !signature) {
    return res.status(401).json({ error: "Invalid signature" });
  }

  try {
    const valid = await receiver.verify({
      body: rawBody,
      signature,
      upstashRegion: getHeader(req, "upstash-region"),
    });
    if (!valid) return res.status(401).json({ error: "Invalid signature" });
  } catch {
    return res.status(401).json({ error: "Invalid signature" });
  }

  let message;
  try {
    message = JSON.parse(rawBody);
    validateSquareWebhookQueueMessage(message);
  } catch (error) {
    const nonRetryable = error instanceof SquareWebhookMessageError || error instanceof SyntaxError;
    if (nonRetryable) res.setHeader("Upstash-NonRetryable-Error", "true");
    return res.status(nonRetryable ? 489 : 400).json({ error: "Invalid payload" });
  }

  const result = await reconcileSquareWebhookMessage(message);
  return res.status(result.statusCode).json(result.body);
}

export const webhookWorkerTestInternals = {
  getReceiver,
};
