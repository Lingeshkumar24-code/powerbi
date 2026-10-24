import type { IncomingMessage, ServerResponse } from "node:http";
import { createApp, type App } from "../server/app";

/**
 * Vercel Node function for every /api/* request. The app instance is reused for
 * the life of a warm lambda; cold starts build a fresh SQLite connection in
 * /tmp. Static files and /v//e/ rewrites are handled by Vercel itself.
 */
let instance: Promise<App> | null = null;

function getApp(): Promise<App> {
  if (!instance) instance = Promise.resolve(createApp());
  return instance;
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const app = await getApp();
  await app.handler(req, res);
}

export const config = {
  runtime: "nodejs22.x",
  maxDuration: 60,
};
