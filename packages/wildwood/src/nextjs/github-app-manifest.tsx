import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type GitHubAppManifestConversion = {
  id: number;
  slug?: string;
  html_url?: string;
  client_id: string;
  client_secret: string;
  webhook_secret?: string | null;
  pem: string;
};

export function githubAppManifestConversionCommand(code: string): string {
  return `gh api --method POST /app-manifests/${code}/conversions`;
}

function envQuote(value: string): string {
  return JSON.stringify(value);
}

function updateEnvContent(
  current: string,
  values: Record<string, string>,
): string {
  const lines = current.split(/\r?\n/);
  const seen = new Set<string>();
  const next = lines.map((line) => {
    const key = Object.keys(values).find((candidate) =>
      line.startsWith(`${candidate}=`),
    );
    if (!key) {
      return line;
    }
    seen.add(key);
    return `${key}=${envQuote(values[key] ?? "")}`;
  });

  const missing = Object.entries(values)
    .filter(([key]) => !seen.has(key))
    .map(([key, value]) => `${key}=${envQuote(value)}`);

  if (missing.length > 0) {
    if (next.length > 0 && next[next.length - 1] !== "") {
      next.push("");
    }
    next.push("# GitHub App manifest flow");
    next.push(...missing);
  }

  return `${next.join("\n").replace(/\n*$/, "")}\n`;
}

async function exchangeManifestCode(
  code: string,
): Promise<GitHubAppManifestConversion> {
  const { stdout } = await execFileAsync("gh", [
    "api",
    "--method",
    "POST",
    `/app-manifests/${code}/conversions`,
  ]);
  return JSON.parse(stdout) as GitHubAppManifestConversion;
}

async function writeManifestEnv(options: {
  conversion: GitHubAppManifestConversion;
  envPath: string;
}) {
  const values: Record<string, string> = {
    GITHUB_APP_ID: String(options.conversion.id),
    GITHUB_CLIENT_ID: options.conversion.client_id,
    GITHUB_CLIENT_SECRET: options.conversion.client_secret,
    GITHUB_PRIVATE_KEY: options.conversion.pem,
  };

  if (options.conversion.slug) {
    values.GITHUB_APP_SLUG = options.conversion.slug;
  }
  if (options.conversion.webhook_secret) {
    values.GITHUB_WEBHOOK_SECRET = options.conversion.webhook_secret;
  }

  let current = "";
  try {
    current = await fs.readFile(options.envPath, "utf8");
  } catch (err) {
    if (!(err instanceof Error) || !("code" in err) || err.code !== "ENOENT") {
      throw err;
    }
  }

  await fs.mkdir(path.dirname(options.envPath), { recursive: true });
  await fs.writeFile(options.envPath, updateEnvContent(current, values));

  return Object.keys(values);
}

function htmlResponse(body: string, init?: ResponseInit) {
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><title>GitHub App Manifest</title></head><body style="font-family: system-ui, sans-serif; max-width: 48rem; margin: 4rem auto; padding: 0 1rem; line-height: 1.5;">${body}</body></html>`,
    {
      ...init,
      headers: {
        "content-type": "text/html; charset=utf-8",
        ...init?.headers,
      },
    },
  );
}

export function createGitHubAppManifestConversionRoute(options?: {
  envPath?: string;
}) {
  return async function POST(request: Request) {
    if (process.env.NODE_ENV === "production") {
      return htmlResponse("<h1>Not available in production</h1>", {
        status: 403,
      });
    }

    const form = await request.formData();
    const code = String(form.get("code") ?? "").trim();
    if (!/^[a-f0-9]+$/i.test(code)) {
      return htmlResponse("<h1>Missing or invalid manifest code</h1>", {
        status: 400,
      });
    }

    try {
      const conversion = await exchangeManifestCode(code);
      const envPath = path.resolve(options?.envPath ?? ".env.local");
      const keys = await writeManifestEnv({ conversion, envPath });
      const appLink = conversion.html_url
        ? `<p><a href="${conversion.html_url}">Open GitHub App settings</a></p>`
        : "";

      return htmlResponse(`
        <h1>GitHub App credentials written</h1>
        <p>Updated <code>${envPath}</code>.</p>
        <p>Wrote: ${keys.map((key) => `<code>${key}</code>`).join(", ")}</p>
        <p>Restart your dev server so the new environment variables are loaded.</p>
        ${appLink}
      `);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return htmlResponse(
        `<h1>Could not exchange manifest code</h1><pre style="white-space: pre-wrap">${message}</pre>`,
        { status: 500 },
      );
    }
  };
}

export function GitHubAppManifestCallback({
  code,
}: {
  code?: string | null;
}) {
  return (
    <section className="w-full max-w-2xl rounded-xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
      <h1 className="text-lg font-semibold text-zinc-950 dark:text-zinc-50">
        GitHub App manifest callback
      </h1>
      {code ? (
        <>
          <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
            GitHub returned a temporary manifest code. Exchange it once to get
            the GitHub App ID, client ID, client secret, webhook secret, and
            private key.
          </p>
          <pre className="mt-4 overflow-auto rounded border border-zinc-200 bg-zinc-50 p-3 text-xs text-zinc-800 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200">
            {githubAppManifestConversionCommand(code)}
          </pre>
          <form action="/api/github-app-manifest/conversions" method="post">
            <input name="code" type="hidden" value={code} />
            <button
              className="mt-4 rounded bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
              type="submit"
            >
              Exchange and write .env.local
            </button>
          </form>
          <p className="mt-4 text-sm text-zinc-600 dark:text-zinc-400">
            This uses your local <code className="font-mono">gh</code> CLI auth
            and writes app credentials into{" "}
            <code className="font-mono">.env.local</code>. Restart your app
            after the file is updated.
          </p>
        </>
      ) : (
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          No manifest code was found in the URL. Create a GitHub App from the
          Wildwood auth controls first, then GitHub should redirect back here.
        </p>
      )}
    </section>
  );
}
