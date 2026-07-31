import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import availabilityHandler from "../api/square/availability.js";
import createBookingHandler from "../api/square/create-booking.js";
import webhookHandler from "../api/square/webhook.js";
import cancelBookingHandler from "../api/square/cancel-booking.js";
import customersHandler from "../api/square/customers.js";
import dashboardAuthHandler from "../api/square/dashboard/auth.js";
import dashboardAppointmentsHandler from "../api/square/dashboard/appointments.js";

const PORT = Number(process.env.LOCAL_API_PORT || 8787);

export function loadDotEnv(baseEnv = process.env, cwd = process.cwd()) {
  const parsed = {};
  for (const file of [".env", ".env.local"]) {
    try {
      const text = readFileSync(resolve(cwd, file), "utf8");
      for (const line of text.split(/\r?\n/)) {
        const match = line.match(/^([A-Za-z0-9_]+)=(.*)$/);
        if (match) parsed[match[1]] = match[2].trim();
      }
    } catch {
      // File absent or unreadable — ignore.
    }
  }
  return { ...parsed, ...baseEnv };
}

const routes = [
  ["GET", "/api/square/availability", availabilityHandler],
  ["POST", "/api/square/create-booking", createBookingHandler],
  ["POST", "/api/square/webhook", webhookHandler],
  ["POST", "/api/square/cancel-booking", cancelBookingHandler],
  ["POST", "/api/square/customers", customersHandler],
  ["GET", "/api/square/customers", customersHandler],
  ["POST", "/api/square/dashboard/auth", dashboardAuthHandler],
  ["GET", "/api/square/dashboard/appointments", dashboardAppointmentsHandler],
];

export function createLocalServer({ env } = {}) {
  if (env) Object.assign(process.env, env);

  return createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const route = routes.find(
      ([method, path]) => method === req.method && path === url.pathname,
    );

    if (!route) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
      return;
    }

    const handler = route[2];

    if (req.method === "GET") {
      req.query = Object.fromEntries(url.searchParams);
    } else {
      const raw = await readAll(req);
      if (url.pathname === "/api/square/webhook") {
        req.body = raw;
      } else if (raw) {
        try {
          req.body = JSON.parse(raw);
        } catch {
          req.body = raw;
        }
      }
    }

    const response = createHandlerResponse(res);
    try {
      await handler(req, response);
    } catch (error) {
      console.error("Local API handler error:", error);
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Internal server error" }));
    }
  });
}

function readAll(req) {
  return new Promise((resolveRead, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolveRead(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function createHandlerResponse(raw) {
  let statusCode = 200;
  return {
    status(code) {
      statusCode = code;
      return this;
    },
    json(data) {
      raw.writeHead(statusCode, { "content-type": "application/json" });
      raw.end(JSON.stringify(data));
    },
  };
}

const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const env = loadDotEnv();
  Object.assign(process.env, env);
  const server = createLocalServer();
  server.listen(PORT, "127.0.0.1", () => {
    console.log(`Local Square API server: http://127.0.0.1:${PORT}`);
  });
}
