import { PlaygroundConfigFormLoader } from "@/components/playground-config-form-loader";
import { PlaygroundConfigIntro } from "@/components/playground-config-intro";
import type { PlaygroundConfig } from "@/lib/playground-config";

type Props = {
  githubSignedIn: boolean;
  initial: PlaygroundConfig;
};

export function PlaygroundControls({ githubSignedIn, initial }: Props) {
  return (
    <section className="w-full max-w-3xl space-y-4">
      <div>
        <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
          Play controls
        </h2>
        <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-500">
          {githubSignedIn
            ? "Choose a GitHub repo or local checkout for the playground."
            : "Sign in with GitHub from the toolbar to enable remote repo picking. Local controls are available now."}
        </p>
      </div>
      <div>
        <PlaygroundConfigIntro />
        <PlaygroundConfigFormLoader
          githubSignedIn={githubSignedIn}
          initial={initial}
        />
      </div>
    </section>
  );
}
