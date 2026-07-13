import { inspect } from "node:util";

/**
 * Verbose `[play] ...` lines: dev by default, or `WILDWOOD_PLAY_LOG=1` in production.
 * Set `WILDWOOD_PLAY_LOG=0` to silence non-error debug lines in development.
 */
export function isPlayVerbose(): boolean {
  if (process.env.WILDWOOD_PLAY_LOG === "0") {
    return false;
  }
  if (process.env.WILDWOOD_PLAY_LOG === "1") {
    return true;
  }
  return process.env.NODE_ENV === "development";
}

function safeLine(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value, (_k, v) => (v === undefined ? "__undefined__" : v));
  } catch {
    return inspect(value, { depth: 6, colors: false, breakLength: 120 });
  }
}

/** Verbose-only: config / step tracing. */
export function playDebug(phase: string, data: Record<string, unknown>): void {
  if (!isPlayVerbose()) {
    return;
  }
  process.stderr.write(`[play] ${phase} ${new Date().toISOString()} ${safeLine(data)}\n`);
}

/** Always: one line per call; cannot collapse to `{}`. */
export function playInfo(phase: string, data: Record<string, unknown>): void {
  process.stderr.write(`[play] ${phase} ${new Date().toISOString()} ${safeLine(data)}\n`);
}

/**
 * Always: multi-line stderr so nothing is lost if a log pipeline stringifies badly.
 * Use this for preview failures (in addition to structured data in playground-error).
 */
export function playFailureHeadline(
  stage: string,
  err: unknown,
  extra?: Record<string, unknown>,
): void {
  const msg =
    err instanceof Error
      ? err.message || "(Error with empty message)"
      : typeof err === "string"
        ? err
        : safeLine(err);
  process.stderr.write(`[play] FAILED at ${stage}: ${msg.replace(/\s+/g, " ").slice(0, 2000)}\n`);
  if (err instanceof Error && err.stack) {
    process.stderr.write(`${err.stack}\n`);
  }
  if (extra && Object.keys(extra).length > 0) {
    process.stderr.write(`[play] FAILED context: ${safeLine(extra)}\n`);
  }
  if (err instanceof Error && err.cause != null) {
    process.stderr.write(
      `[play] FAILED cause: ${safeLine(
        err.cause instanceof Error
          ? { message: err.cause.message, stack: err.cause.stack }
          : err.cause,
      )}\n`,
    );
  }
}
