"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useId, useState, useTransition } from "react";
import {
  PLAYGROUND_CONFIG_COOKIE,
  type PlaygroundConfig,
  type PlaygroundSource,
  serializePlaygroundConfig,
} from "@/lib/playground-config";

const COOKIE_MAX_AGE = 60 * 60 * 24 * 365; // 1 year
const formClass =
  "grid gap-3 w-full rounded-lg border border-zinc-200 bg-zinc-50/80 p-4 text-left dark:border-zinc-800 dark:bg-zinc-900/40 sm:grid-cols-2";
const labelClass = "text-xs font-medium text-zinc-600 dark:text-zinc-400";
const inputClass =
  "mt-0.5 w-full rounded border border-zinc-300 bg-white px-2 py-1.5 text-sm text-zinc-900 shadow-sm focus:border-zinc-500 focus:outline-none focus:ring-1 focus:ring-zinc-500 dark:border-zinc-600 dark:bg-zinc-950 dark:text-zinc-100";

type Props = {
  githubSignedIn: boolean;
  initial: PlaygroundConfig;
};

type RepoSuggestion = {
  defaultBranch: string;
  fullName: string;
  name: string;
  owner: string;
  private: boolean;
};

type GitHubAccount = {
  avatarUrl: string | null;
  login: string;
  type: "user" | "org";
};

function readConfigFromForm(form: HTMLFormElement): PlaygroundConfig {
  const fd = new FormData(form);
  const source = fd.get("source");
  if (source !== "github" && source !== "local") {
    throw new Error("Invalid source: choose GitHub or local");
  }
  const org = String(fd.get("org") ?? "").trim();
  const repo = String(fd.get("repo") ?? "").trim();
  const ref = String(fd.get("ref") ?? "").trim();
  const match = String(fd.get("match") ?? "").trim();
  const localPath = String(fd.get("localPath") ?? "").trim();
  const contentType = fd.get("contentType");
  if (contentType !== "md" && contentType !== "json") {
    throw new Error("Invalid content type");
  }
  if (!org || !repo || !ref || !match) {
    throw new Error("org, repo, ref, and match are required");
  }
  return {
    source,
    org,
    repo,
    ref,
    localPath: source === "local" ? localPath : "",
    match,
    contentType,
  };
}

function setClientCookie(name: string, value: string, maxAge: number) {
  const secure = typeof window !== "undefined" && window.location?.protocol === "https:";
  const parts = [`${name}=${value}`, "Path=/", `Max-Age=${maxAge}`, "SameSite=Lax"];
  if (secure) {
    parts.push("Secure");
  }
  document.cookie = parts.join("; ");
}

function clearClientCookie(name: string) {
  document.cookie = `${name}=; Path=/; Max-Age=0; SameSite=Lax`;
}

export function PlaygroundConfigForm({ githubSignedIn, initial }: Props) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const effectiveInitial: PlaygroundConfig =
    githubSignedIn || initial.source === "local" ? initial : { ...initial, source: "local" };
  const effectiveInitialKey = `${effectiveInitial.source}\x1e${effectiveInitial.org}\x1e${effectiveInitial.repo}\x1e${effectiveInitial.ref}\x1e${effectiveInitial.localPath}\x1e${effectiveInitial.match}\x1e${effectiveInitial.contentType}\x1e${githubSignedIn}`;
  const [source, setSource] = useState<PlaygroundSource>(effectiveInitial.source);
  const [org, setOrg] = useState(effectiveInitial.org);
  const [repo, setRepo] = useState(effectiveInitial.repo);
  const [ref, setRef] = useState(effectiveInitial.ref);
  const [accounts, setAccounts] = useState<GitHubAccount[]>([]);
  const [accountsLoading, setAccountsLoading] = useState(false);
  const [repos, setRepos] = useState<RepoSuggestion[]>([]);
  const [repoFilter, setRepoFilter] = useState("");
  const [repoLoading, setRepoLoading] = useState(false);
  const baseId = useId();
  const selectedAccountType = accounts.find((account) => account.login === org)?.type ?? "user";
  const filteredRepos = repos.filter((item) => {
    const q = repoFilter.trim().toLowerCase();
    if (!q) {
      return true;
    }
    return item.name.toLowerCase().includes(q);
  });

  useEffect(() => {
    setSource(effectiveInitial.source);
    setOrg(effectiveInitial.org);
    setRepo(effectiveInitial.repo);
    setRef(effectiveInitial.ref);
    setRepoFilter("");
  }, [
    effectiveInitial.contentType,
    effectiveInitial.localPath,
    effectiveInitial.match,
    effectiveInitial.org,
    effectiveInitial.repo,
    effectiveInitial.ref,
    effectiveInitial.source,
    githubSignedIn,
  ]);

  useEffect(() => {
    if (!githubSignedIn && source === "github") {
      setSource("local");
    }
  }, [githubSignedIn, source]);

  useEffect(() => {
    if (!githubSignedIn || source !== "github") {
      setAccounts([]);
      setRepos([]);
      setAccountsLoading(false);
      setRepoLoading(false);
      return undefined;
    }

    const controller = new AbortController();
    setAccountsLoading(true);
    void (async () => {
      try {
        const response = await fetch("/api/github/accounts", {
          credentials: "include",
          signal: controller.signal,
        });
        if (!response.ok) {
          setAccounts([]);
          return;
        }
        const data = (await response.json()) as {
          accounts?: GitHubAccount[];
        };
        const nextAccounts = data.accounts ?? [];
        setAccounts(nextAccounts);
        setOrg((current) =>
          nextAccounts.length > 0 && !nextAccounts.some((account) => account.login === current)
            ? (nextAccounts[0]?.login ?? current)
            : current,
        );
      } catch {
        if (!controller.signal.aborted) {
          setAccounts([]);
        }
      } finally {
        if (!controller.signal.aborted) {
          setAccountsLoading(false);
        }
      }
    })();

    return () => {
      controller.abort();
    };
  }, [githubSignedIn, source]);

  useEffect(() => {
    if (!githubSignedIn || source !== "github" || !org) {
      setRepos([]);
      setRepoLoading(false);
      return undefined;
    }

    const controller = new AbortController();
    setRepoLoading(true);
    void (async () => {
      try {
        const params = new URLSearchParams({
          owner: org,
          ownerType: selectedAccountType,
        });
        const response = await fetch(`/api/github/repos?${params}`, {
          credentials: "include",
          signal: controller.signal,
        });
        if (!response.ok) {
          setRepos([]);
          return;
        }
        const data = (await response.json()) as { repos?: RepoSuggestion[] };
        const nextRepos = data.repos ?? [];
        setRepos(nextRepos);
        if (nextRepos.length > 0) {
          setRepo((current) => {
            const selected = nextRepos.find((item) => item.name === current);
            if (selected) {
              setRef(selected.defaultBranch);
              return current;
            }
            const first = nextRepos[0];
            if (first) {
              setRef(first.defaultBranch);
              return first.name;
            }
            return current;
          });
        }
      } catch {
        if (!controller.signal.aborted) {
          setRepos([]);
        }
      } finally {
        if (!controller.signal.aborted) {
          setRepoLoading(false);
        }
      }
    })();

    return () => {
      controller.abort();
    };
  }, [githubSignedIn, org, selectedAccountType, source]);

  function chooseRepo(name: string) {
    const suggestion = repos.find((item) => item.name === name);
    if (!suggestion) {
      setRepo(name);
      return;
    }
    setOrg(suggestion.owner);
    setRepo(suggestion.name);
    setRef(suggestion.defaultBranch);
  }

  function apply(serialize: (c: PlaygroundConfig) => string) {
    return (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      setErr(null);
      start(() => {
        try {
          const config = readConfigFromForm(e.currentTarget);
          setClientCookie(PLAYGROUND_CONFIG_COOKIE, serialize(config), COOKIE_MAX_AGE);
          router.refresh();
        } catch (ex) {
          setErr(ex instanceof Error ? ex.message : "Invalid input");
        }
      });
    };
  }

  return (
    <div className="w-full max-w-3xl">
      <form
        className="space-y-3"
        key={effectiveInitialKey}
        onSubmit={apply(serializePlaygroundConfig)}
      >
        <div className={formClass}>
          <div className="sm:col-span-2 space-y-2 rounded border border-dashed border-zinc-200 p-3 dark:border-zinc-700">
            <span className={labelClass}>Source</span>
            <div className="mt-1 flex flex-wrap gap-4 text-sm">
              {githubSignedIn ? (
                <label className="inline-flex items-center gap-1.5">
                  <input
                    checked={source === "github"}
                    name="source"
                    onChange={() => {
                      setSource("github");
                    }}
                    type="radio"
                    value="github"
                  />
                  GitHub (remote)
                </label>
              ) : null}
              <label className="inline-flex items-center gap-1.5">
                <input
                  checked={source === "local"}
                  name="source"
                  onChange={() => {
                    setSource("local");
                  }}
                  type="radio"
                  value="local"
                />
                Local directory (git on disk)
              </label>
            </div>
            {!githubSignedIn ? (
              <p className="text-[11px] text-zinc-500">
                GitHub repo picking appears after you sign in with GitHub from the toolbar.
              </p>
            ) : null}
          </div>
          {githubSignedIn && source === "github" ? (
            <>
              <div className="sm:col-span-1">
                <label className={labelClass} htmlFor={`${baseId}-org`}>
                  Account
                </label>
                <select
                  className={inputClass}
                  disabled={accountsLoading}
                  id={`${baseId}-org`}
                  name="org"
                  onChange={(event) => {
                    setOrg(event.currentTarget.value);
                    setRepoFilter("");
                  }}
                  required
                  value={org}
                >
                  {accounts.some((account) => account.login === org) ? null : (
                    <option value={org}>{org}</option>
                  )}
                  {accounts.map((account) => (
                    <option key={account.login} value={account.login}>
                      {account.login} {account.type === "org" ? "(org)" : "(user)"}
                    </option>
                  ))}
                </select>
              </div>
              <div className="sm:col-span-1">
                <label className={labelClass} htmlFor={`${baseId}-repo-filter`}>
                  Search repositories
                </label>
                <input
                  className={inputClass}
                  id={`${baseId}-repo-filter`}
                  onChange={(event) => setRepoFilter(event.currentTarget.value)}
                  placeholder="Filter repos..."
                  type="search"
                  value={repoFilter}
                />
              </div>
              <div className="sm:col-span-2">
                <label className={labelClass} htmlFor={`${baseId}-repo`}>
                  Repository
                </label>
                <select
                  className={inputClass}
                  disabled={repoLoading && filteredRepos.length === 0}
                  id={`${baseId}-repo`}
                  name="repo"
                  onChange={(event) => chooseRepo(event.currentTarget.value)}
                  required
                  value={repo}
                >
                  {filteredRepos.some((item) => item.name === repo) ? null : (
                    <option value={repo}>{repo}</option>
                  )}
                  {filteredRepos.map((item) => (
                    <option key={item.fullName} value={item.name}>
                      {item.name} · {item.private ? "private" : "public"} · {item.defaultBranch}
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-[11px] text-zinc-500">
                  {accountsLoading
                    ? "Loading GitHub accounts..."
                    : repoLoading
                      ? "Loading repositories..."
                      : "Choose an account, then select a repo from that account."}
                </p>
              </div>
            </>
          ) : null}
          {source === "local" ? (
            <>
              <div className="sm:col-span-1">
                <label className={labelClass} htmlFor={`${baseId}-org`}>
                  Organization
                </label>
                <input
                  className={inputClass}
                  id={`${baseId}-org`}
                  name="org"
                  onChange={(event) => setOrg(event.currentTarget.value)}
                  required
                  type="text"
                  value={org}
                />
              </div>
              <div className="sm:col-span-1">
                <label className={labelClass} htmlFor={`${baseId}-repo`}>
                  Repository
                </label>
                <input
                  className={inputClass}
                  id={`${baseId}-repo`}
                  name="repo"
                  onChange={(event) => setRepo(event.currentTarget.value)}
                  required
                  type="text"
                  value={repo}
                />
              </div>
            </>
          ) : null}
          {source === "local" && (
            <p className="sm:col-span-2 text-[11px] text-zinc-500">
              The path above must be the git worktree. Org/repo must match how this DB was first
              indexed (e.g. repo{" "}
              <code className="text-zinc-600 dark:text-zinc-500">wildwood-mono</code> if you started
              from defaults); changing to{" "}
              <code className="text-zinc-600 dark:text-zinc-500">wildwood</code> alone does not
              “rename” stored blobs and can cause empty previews.
            </p>
          )}
          <div className="sm:col-span-1">
            <label className={labelClass} htmlFor={`${baseId}-ref`}>
              Ref (default branch)
            </label>
            <input
              className={inputClass}
              id={`${baseId}-ref`}
              name="ref"
              onChange={(event) => setRef(event.currentTarget.value)}
              required
              type="text"
              value={ref}
            />
          </div>
          {source === "local" && (
            <div className="sm:col-span-2">
              <label className={labelClass} htmlFor={`${baseId}-localPath`}>
                Local git clone path (optional)
              </label>
              <input
                className={inputClass}
                defaultValue={effectiveInitial.localPath}
                id={`${baseId}-localPath`}
                key={`${effectiveInitial.localPath}-${source}`}
                name="localPath"
                placeholder="Empty = auto-detect from dev server cwd"
                type="text"
              />
              <p className="mt-1 text-[11px] text-zinc-500">
                Leave empty for zero-config dev — Wildwood auto-detects the git root from the Next
                dev server cwd. Set only if your checkout lives elsewhere.
              </p>
            </div>
          )}
          <div className="sm:col-span-2">
            <label className={labelClass} htmlFor={`${baseId}-match`}>
              Match (glob)
            </label>
            <input
              className={inputClass}
              defaultValue={effectiveInitial.match}
              id={`${baseId}-match`}
              name="match"
              required
              type="text"
            />
          </div>
          <div className="sm:col-span-2">
            <span className={labelClass}>File type (schema)</span>
            <div className="mt-1 flex flex-wrap gap-3 text-sm">
              <label className="inline-flex items-center gap-1.5">
                <input
                  defaultChecked={effectiveInitial.contentType === "md"}
                  name="contentType"
                  type="radio"
                  value="md"
                />
                Markdown
              </label>
              <label className="inline-flex items-center gap-1.5">
                <input
                  defaultChecked={effectiveInitial.contentType === "json"}
                  name="contentType"
                  type="radio"
                  value="json"
                />
                JSON
              </label>
            </div>
          </div>
        </div>
        {err != null && (
          <p className="text-xs text-red-600 dark:text-red-400" role="alert">
            {err}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <button
            className="rounded bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
            disabled={pending}
            type="submit"
          >
            {pending ? "Applying…" : "Apply"}
          </button>
          <button
            className="rounded border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-800 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
            disabled={pending}
            type="button"
            onClick={() => {
              setErr(null);
              start(() => {
                clearClientCookie(PLAYGROUND_CONFIG_COOKIE);
                router.refresh();
              });
            }}
          >
            Clear cookie (defaults)
          </button>
        </div>
      </form>
    </div>
  );
}
