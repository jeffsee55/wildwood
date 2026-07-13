"use client";

import { createAuthClient } from "better-auth/react";
import { useRouter } from "next/navigation";
import { type FormEvent, useState, useTransition } from "react";

const authClient = createAuthClient();

type Props = {
  githubEnabled: boolean;
};

const inputClass =
  "mt-1 w-full rounded border border-zinc-300 bg-white px-2 py-1.5 text-sm text-zinc-900 shadow-sm focus:border-zinc-500 focus:outline-none focus:ring-1 focus:ring-zinc-500 dark:border-zinc-600 dark:bg-zinc-950 dark:text-zinc-100";

export function PlaygroundAuthPanel({ githubEnabled }: Props) {
  const router = useRouter();
  const [mode, setMode] = useState<"sign-in" | "sign-up">("sign-in");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") ?? "").trim();
    const password = String(form.get("password") ?? "");
    const name = String(form.get("name") ?? "").trim() || email;

    startTransition(async () => {
      setError(null);
      const result =
        mode === "sign-up"
          ? await authClient.signUp.email({ email, password, name })
          : await authClient.signIn.email({ email, password });

      if (result.error) {
        setError(result.error.message || "Authentication failed");
        return;
      }

      router.refresh();
    });
  }

  return (
    <main className="flex min-h-svh w-full flex-1 items-center justify-center bg-zinc-50 px-6 py-16 font-sans dark:bg-black">
      <section className="w-full max-w-sm rounded-xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
        <h1 className="text-lg font-semibold text-zinc-950 dark:text-zinc-50">
          Sign in to Wildwood Play
        </h1>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          Authentication gates the editor and git mutation APIs. Better Auth tables live in the same
          app database as the playground.
        </p>

        {githubEnabled && (
          <button
            className="mt-5 w-full rounded border border-zinc-300 bg-white px-3 py-2 text-sm font-medium text-zinc-900 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800"
            disabled={pending}
            onClick={() => {
              startTransition(async () => {
                setError(null);
                await authClient.signIn.social({
                  provider: "github",
                  callbackURL: "/",
                });
              });
            }}
            type="button"
          >
            Continue with GitHub
          </button>
        )}

        <form className="mt-5 space-y-3" onSubmit={onSubmit}>
          {mode === "sign-up" && (
            <label className="block text-xs font-medium text-zinc-600 dark:text-zinc-400">
              Name
              <input className={inputClass} name="name" type="text" />
            </label>
          )}
          <label className="block text-xs font-medium text-zinc-600 dark:text-zinc-400">
            Email
            <input autoComplete="email" className={inputClass} name="email" required type="email" />
          </label>
          <label className="block text-xs font-medium text-zinc-600 dark:text-zinc-400">
            Password
            <input
              autoComplete={mode === "sign-up" ? "new-password" : "current-password"}
              className={inputClass}
              minLength={8}
              name="password"
              required
              type="password"
            />
          </label>

          {error && (
            <p className="text-xs text-red-600 dark:text-red-400" role="alert">
              {error}
            </p>
          )}

          <button
            className="w-full rounded bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
            disabled={pending}
            type="submit"
          >
            {pending ? "Working..." : mode === "sign-up" ? "Create account" : "Sign in"}
          </button>
        </form>

        <button
          className="mt-4 text-sm text-zinc-600 underline-offset-4 hover:underline dark:text-zinc-400"
          disabled={pending}
          onClick={() => {
            setError(null);
            setMode((current) => (current === "sign-in" ? "sign-up" : "sign-in"));
          }}
          type="button"
        >
          {mode === "sign-in" ? "Need an account? Sign up" : "Already have an account? Sign in"}
        </button>
      </section>
    </main>
  );
}
