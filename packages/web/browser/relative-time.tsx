import { useEffect, useState } from "react";

export function RelativeTime({ value }: { value: number }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.floor((now - value) / 1000));
  const label =
    seconds < 60
      ? "just now"
      : seconds < 3600
        ? `${Math.floor(seconds / 60)} min ago`
        : seconds < 86400
          ? `${Math.floor(seconds / 3600)} hr ago`
          : seconds < 604800
            ? `${Math.floor(seconds / 86400)}d ago`
            : seconds < 2592000
              ? `${Math.floor(seconds / 604800)}w ago`
              : seconds < 31536000
                ? `${Math.floor(seconds / 2592000)}mo ago`
                : `${Math.floor(seconds / 31536000)}y ago`;
  return (
    <time
      className="draft-time"
      dateTime={new Date(value).toISOString()}
      title={new Date(value).toLocaleString()}
    >
      {label}
    </time>
  );
}
