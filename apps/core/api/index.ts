/**
 * Vercel function (Node.js runtime): every path is rewritten here by
 * vercel.json. Web-standard handlers (Request → Response) per HTTP method,
 * the same shape hono/vercel's `handle(app)` produces, with the app built
 * lazily on the first request of a warm instance.
 */
import { createServerlessHandler } from '../src/serverless.js';

const handler = createServerlessHandler();

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
export const OPTIONS = handler;
export const HEAD = handler;
