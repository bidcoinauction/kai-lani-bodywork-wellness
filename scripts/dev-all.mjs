import { spawn } from "node:child_process";

const children = [];
const isWin = process.platform === "win32";

function run(name, command, args, options = {}) {
  const child = spawn(command, args, {
    stdio: "inherit",
    shell: isWin,
    ...options,
  });
  children.push(child);
  child.on("exit", (code) => {
    if (code !== 0) {
      shutdown(code || 1);
    }
  });
  return child;
}

function shutdown(code = 0) {
  for (const child of children) {
    if (!child.killed) {
      child.kill();
    }
  }
  process.exit(code);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

run("api", "node", ["scripts/local-api-server.mjs"], { env: { ...process.env } });
run("vite", "npm", ["run", "dev"], { env: { ...process.env } });
