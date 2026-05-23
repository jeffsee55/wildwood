"use client";

import { createAuthClient } from "better-auth/react";
import { useRouter } from "next/navigation";
import { useTransition } from "react";

const authClient = createAuthClient();

type Props = {
  email: string;
};

export function PlaygroundUserMenu({ email }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <div className="flex w-full max-w-3xl items-center justify-between gap-3 rounded-lg border border-zinc-200 bg-zinc-50/80 px-4 py-2 text-xs text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900/40 dark:text-zinc-400">
      <span>
        Signed in as{" "}
        <span className="font-medium text-zinc-800 dark:text-zinc-200">
          {email}
        </span>
      </span>
      <button
        className="rounded border border-zinc-300 bg-white px-2 py-1 font-medium text-zinc-800 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
        disabled={pending}
        onClick={() => {
          startTransition(async () => {
            await authClient.signOut();
            router.refresh();
          });
        }}
        type="button"
      >
        Sign out
      </button>
    </div>
  );
}
