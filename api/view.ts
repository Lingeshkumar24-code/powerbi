import type { IncomingMessage, ServerResponse } from "node:http";
import { createApp, type App } from "../server/app";

/**
 * Serves /v/:token and /e/:token through the real server handler so share
 * validation and the per-embed frame-ancestors CSP are enforced on Vercel too.
 * vercel.json rewrites those paths to /api/view with the original path in a
 * query parameter; Vercel's filesystem would otherwise serve viewer.html with
 * no validation.
 */
let instance: Promise<App> | null = null;

function getApp(): Promise<App> {
  if (!instance) instance = Promise.resolve(createApp());
  return instance;
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const incoming = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const kind = incoming.searchParams.get("kind") === "embed" ? "e" : "v";
  const path = incoming.searchParams.get("path") || "";
  req.url = `/${kind}/${path}`;
  const app = await getApp();
  await app.handler(req, res);
}

export const config = {
  runtime: "nodejs22.x",
  maxDuration: 30,
};
