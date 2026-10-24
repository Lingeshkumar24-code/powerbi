import { createApp } from "./app.ts";
import { findBrowser } from "./config.ts";

try {
  process.loadEnvFile?.();
} catch {
  // no .env; configuration comes from the environment
}

const app = createApp();
const { url } = await app.listen();
const cfg = app.config;
const browser = findBrowser(cfg.browserBin);

console.log("");
console.log(`  PowerBICraft service  ${url}`);
console.log(`  data directory        ${cfg.dataDir}`);
console.log(`  database              ${cfg.dbPath}`);
console.log(`  mail transport        ${cfg.mail.transport}${cfg.mail.smtpUrl ? "" : " (messages land in the outbox)"}`);
console.log(`  snapshots             ${cfg.snapshot ? (browser ? browser : "no browser found — HTML fallback") : "disabled"}`);
console.log(`  scheduler             ${cfg.scheduler ? `every ${Math.round(cfg.tickMs / 1000)}s` : "disabled"}`);
console.log("");

let closing = false;
const shutdown = async (signal: string) => {
  if (closing) return;
  closing = true;
  console.log(`\n[${signal}] shutting down`);
  await app.close();
  process.exit(0);
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
