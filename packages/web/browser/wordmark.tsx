/** Font-independent ww. mark, drawn for the compact toolbar launcher. */
export function Wordmark() {
  return (
    <svg
      className="ww-wordmark size-logo"
      viewBox="0 0 60 36"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M5 6 12 28 19 6 26 28 33 6 40 28 47 6"
        fill="none"
        stroke="currentColor"
        strokeWidth="4.5"
        strokeLinejoin="bevel"
      />
      <circle cx="55" cy="28" r="2.5" />
    </svg>
  );
}
