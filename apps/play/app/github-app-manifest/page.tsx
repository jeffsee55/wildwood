import { GitHubAppManifestCallback } from "tr33/nextjs";

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

function firstParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }
  return value ?? null;
}

export default async function GithubAppManifestPage({
  searchParams,
}: PageProps) {
  const params = await searchParams;
  const code = firstParam(params.code);

  return (
    <main className="flex min-h-svh w-full flex-1 items-center justify-center bg-zinc-50 px-6 py-16 font-sans dark:bg-black">
      <GitHubAppManifestCallback code={code} />
    </main>
  );
}
