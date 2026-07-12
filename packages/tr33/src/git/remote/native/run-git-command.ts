import { spawn } from "node:child_process";
import { err, ok, type Result } from "neverthrow";

export type GitRunOptions = {
  cwd: string;
  /** Args without the leading `git`. e.g. ["rev-parse","HEAD"] */
  args: string[];
  /** Stdin payload — string for text commands, Buffer for binary. */
  input?: string | Uint8Array | Buffer;
  /** Max buffered stdout/stderr before aborting (bytes). */
  maxBuffer?: number;
};

function toError(e: unknown): Error {
  if (e instanceof Error) return e;
  return new Error(String(e));
}

/**
 * Single, shell-free git runner. No shell interpolation, no `command.split(" ")`.
 *
 * Returns `Result<string,Error>` for text commands and `Result<Buffer,Error>` for binary.
 * Caller decides which variant to need via return type.
 */
export async function runGit(
  opts: GitRunOptions,
): Promise<Result<string, Error>> {
  const res = await runGitBuffer(opts);
  if (res.isErr()) return err(res.error);
  return ok(res.value.toString("utf-8"));
}

export async function runGitBuffer(
  opts: GitRunOptions,
): Promise<Result<Buffer, Error>> {
  const { cwd, args, input, maxBuffer = 50 * 1024 * 1024 } = opts;
  return new Promise((resolve) => {
    const cp = spawn("git", args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });

    const chunks: Buffer[] = [];
    let total = 0;
    let stderr = "";
    let settled = false;
    const finish = (r: Result<Buffer, Error>) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };

    cp.stdout.on("data", (d: Buffer) => {
      total += d.length;
      if (total > maxBuffer) {
        cp.kill();
        finish(
          err(new Error(`git ${args[0]} exceeded maxBuffer ${maxBuffer}`)),
        );
        return;
      }
      chunks.push(d);
    });
    cp.stderr.on("data", (d: Buffer) => {
      stderr += d.toString("utf-8");
    });
    cp.on("error", (e) => finish(err(toError(e))));
    cp.on("close", (code) => {
      if (code === 0) {
        finish(ok(Buffer.concat(chunks)));
      } else {
        finish(
          err(
            new Error(
              stderr.trim() ||
                `git ${args.join(" ")} failed with code ${code}`,
            ),
          ),
        );
      }
    });

    if (input !== undefined) {
      // biome-ignore lint/suspicious/noExplicitAny: BufferSource overload
      cp.stdin.write(input as any);
    }
    cp.stdin.end();
  });
}

export type StdoutStringResult = Result<string, Error>;
export type StdoutBufferResult = Result<Buffer, Error>;

// --- Back-compat shims to be removed once call sites migrate -----------------
// Kept only so incremental refactor doesn't block on every file.
// TODO: delete.

export const _runGitCommand = (args: {
  command: string;
  cwd: string;
  stdinInput?: string;
  env?: string;
}) => runGit({ cwd: args.cwd, args: args.command.split(" "), input: args.stdinInput });

export const _runGitCommand2 = async (args: {
  command: string;
  cwd: string;
  stdinInput?: Buffer;
}) => {
  const r = await runGitBuffer({
    cwd: args.cwd,
    args: args.command.split(" "),
    input: args.stdinInput,
  });
  if (r.isErr()) throw r.error;
  return r.value.toString("utf-8").trim();
};

export const _runGitCommandBuffer = (args: {
  command: string;
  cwd: string;
  stdinInput?: string;
}) =>
  runGitBuffer({
    cwd: args.cwd,
    args: args.command.split(" "),
    input: args.stdinInput,
  });
