type Props = {
  title?: string;
  message: string;
};

export function PlaygroundDataError({
  title = "Wildwood preview error",
  message,
}: Props) {
  return (
    <div
      className="w-full rounded-lg border border-amber-200 bg-amber-50 p-4 text-left text-sm text-amber-950 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-100"
      role="alert"
    >
      <p className="font-medium">{title}</p>
      <pre className="mt-2 max-h-[min(70vh,32rem)] overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-amber-900/90 dark:text-amber-100/90">
        {message}
      </pre>
    </div>
  );
}
