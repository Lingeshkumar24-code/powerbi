import { createApp } from "./app.ts";

// Node 20.12+/24 can read .env without a dependency. Ignore a missing file.
try {
  process.loadEnvFile?.();
} catch {
  // no .env, environment variables come from the host
}

const app = createApp();
const cfg = app.config;

console.log("");
console.log("  PowerBICraft refresh worker");
console.log(`  database              ${cfg.dbPath}`);
console.log(`  data directory        ${cfg.dataDir}`);
console.log(`  instance              ${cfg.instanceId}`);
console.log(`  tick                  every ${Math.round(cfg.tickMs / 1000)}s`);
console.log("  (run the API with PBC_SCHEDULER=0 when this worker is active)");
console.log("");

// startScheduler uses an unref'd timer; keep the worker process alive.
const keepAlive = setInterval(() => {}, 60_000);

let closing = false;
const shutdown = async (signal: string) => {
  if (closing) return;
  closing = true;
  console.log(`\n[${signal}] stopping worker`);
  clearInterval(keepAlive);
  await app.close();
  app.db.close();
  process.exit(0);
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
