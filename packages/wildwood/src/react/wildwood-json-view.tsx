"use client";

import JsonView from "@uiw/react-json-view";
import { darkTheme } from "@uiw/react-json-view/dark";
import { lightTheme } from "@uiw/react-json-view/light";
import { useSyncExternalStore, type CSSProperties } from "react";

function subscribePrefersDark(onChange: () => void) {
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

function getPrefersDarkSnapshot() {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function getPrefersDarkServerSnapshot() {
  return false;
}

export type WildwoodJsonViewProps = {
  /** JSON-serializable object to display */
  value: object;
  className?: string;
  /**
   * Collapse nested nodes deeper than this level (same idea as JsonView `collapsed={n}`).
   * @default 2
   */
  collapsedDepth?: number;
  /**
   * When the root has an array at this key, the **first** element (`[key, 0]`) starts **expanded**
   * so e.g. `items[0]` is open for debugging list payloads.
   * @default "items"
   */
  expandFirstItemUnderKey?: string;
};

/**
 * Themed JSON tree for debugging (uses [`@uiw/react-json-view`](https://github.com/uiwjs/react-json-view)).
 * Follows system light/dark when no explicit theme is provided.
 */
export function WildwoodJsonView({
  value,
  className = "w-full min-w-0 max-h-[min(70vh,560px)] overflow-auto rounded-md border border-zinc-200 bg-white p-2 dark:border-zinc-800 dark:bg-zinc-950",
}: WildwoodJsonViewProps) {
  const prefersDark = useSyncExternalStore(
    subscribePrefersDark,
    getPrefersDarkSnapshot,
    getPrefersDarkServerSnapshot,
  );

  const theme = prefersDark ? darkTheme : lightTheme;

  return (
    <div className={className}>
      <JsonView
        value={value}
        style={theme as CSSProperties}
        collapsed={false}
        shouldExpandNodeInitially={(isExpanded, { keys, level }) => {
          if (
            keys.join(".") === 'items.0'
          ) {
            return true;
          }
          return isExpanded;
        }}
        displayObjectSize={false}
        displayDataTypes={false}
        enableClipboard={false}
        className="text-xs leading-relaxed"
      />
    </div>
  );
}
