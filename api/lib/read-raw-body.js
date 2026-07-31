/**
 * Collects the exact raw request body string. Used only for webhook signature
 * verification, where the raw bytes must match what Square signed.
 *
 * Prefers an already-buffered string/Buffer body (local Node http). Otherwise
 * reads the request stream. Returns null when the body is unavailable (for
 * example, when the platform pre-parsed a JSON body into an object).
 */
export async function readRawBody(req) {
  try {
    if (typeof req.body === "string") return req.body;
    if (Buffer.isBuffer(req.body)) return req.body.toString("utf8");
  } catch {
    return null;
  }

  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  if (chunks.length === 0) return null;
  return Buffer.concat(chunks).toString("utf8");
}
