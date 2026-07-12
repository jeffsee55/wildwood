import { GitHubAppManifestCallback } from "wildwood/nextjs";

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

function firstParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

export default async function GithubAppManifestPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const code = firstParam(params.code);
  const state = firstParam(params.state);
  // We can't read httpOnly cookie here server-side without next/headers, so pass no validation;
  // bundled callback does real validation. This page kept for backward compat.
  void state;

  return (
    <main className="flex min-h-svh w-full flex-1 flex-col items-center gap-6 bg-zinc-50 px-6 py-16 font-sans dark:bg-black">
      <div className="w-full max-w-2xl rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
        Legacy callback path. New flow uses <code>/api/wildwood/github/app-manifest/callback</code> automatically if you used the toolbar&apos;s
        Create GitHub App after this deploy.
      </div>
      <GitHubAppManifestCallback code={code} />
      <p className="text-xs text-zinc-500">
        Preferred URL after migration: <code>/api/wildwood/github/app-manifest/callback?code=…&amp;state=…</code>
      </p>
    </main>
  );
}
