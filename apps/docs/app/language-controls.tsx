"use client";

import { useFormStatus } from "react-dom";

export function LanguageControls({ locale, pinned }: { locale: string; pinned: boolean }) {
  const { pending } = useFormStatus();
  return (
    <>
      <label>
        Language{" "}
        <select disabled={pinned || pending} name="locale" defaultValue={locale}>
          <option value="en">English</option>
          <option value="fr">Français</option>
        </select>
      </label>
      <button disabled={pinned || pending} aria-live="polite">
        {pending ? "Switching…" : "Apply"}
      </button>
    </>
  );
}
