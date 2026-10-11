import { SelectField } from "./ui/select-field";
import { Dialog, DialogContent, DialogClose, DialogTitle, DialogDescription } from "./ui/dialog";
import { Checkbox } from "./ui/checkbox";
import { Textarea } from "./ui/textarea";
import { Label } from "./ui/label";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "./ui/collapsible";
import { useState, useRef } from "react";
import { requestJson } from "./request";
import { retryKey } from "./editor-model";
import { Button } from "./ui/button";
type Plan = {
  plan: string;
  upToDate: boolean;
  clean: boolean;
  conflicts: string[];
  messages: { type: string; message: string }[];
};
type Content = { source: string | null; binary: boolean; tooLarge?: boolean } | null;
type File = { path: string; base: Content; ours: Content; theirs: Content; merged: Content };
type Resolution =
  | { path: string; side: "ours" | "theirs" }
  | { path: string; source: string }
  | { path: string; delete: true };
export function DraftUpdate({
  endpoint,
  draft,
  onUpdated,
}: {
  endpoint: string;
  draft: string;
  onUpdated: (revision: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false),
    [plan, setPlan] = useState<Plan | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [files, setFiles] = useState<Record<string, File>>({}),
    [choices, setChoices] = useState<Record<string, Resolution>>({}),
    [confirmed, setConfirmed] = useState(false);
  const attempt = useRef<{ payload: string; key: string } | null>(null);
  const request = (body: object) => requestJson(endpoint + "/command", body);
  async function start() {
    setOpen(true);
    setBusy(true);
    setError("");
    setPlan(null);
    setChoices({});
    setFiles({});
    setConfirmed(false);
    attempt.current = null;
    try {
      setPlan(await request({ type: "draft-merge-plan", id: draft }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function inspect(path: string) {
    setBusy(true);
    setError("");
    try {
      const value = await request({ type: "draft-merge-file", plan: plan!.plan, path });
      setFiles((f) => ({ ...f, [path]: value }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function apply() {
    const body = {
      type: "draft-merge-apply",
      id: draft,
      plan: plan!.plan,
      resolutions: Object.values(choices),
      confirmConflicts: confirmed,
    };
    attempt.current = retryKey(attempt.current, body);
    setBusy(true);
    setError("");
    try {
      const result = await request({ ...body, command: attempt.current.key });
      await onUpdated(result.reviewRevision);
      setOpen(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const show = (c: Content) =>
    c === null
      ? "File deleted / absent"
      : c.tooLarge
        ? "Too large to display. Choose a side."
        : c.binary
          ? "Binary file. Choose a side."
          : c.source;
  return (
    <>
      <Button onClick={start}>Update draft with Git</Button>
      <Dialog
        open={open}
        onOpenChange={(v) => {
          if (!busy) setOpen(v);
        }}
      >
        <DialogContent showCloseButton={false} className="review-dialog merge-dialog">
          <DialogTitle>Update your draft</DialogTitle>
          <DialogDescription>
            Git combines your branch with the latest published content. Review and approve the
            updated draft before publishing.
          </DialogDescription>
          {busy && !plan && <p>Computing Git merge…</p>}
          {error && <p role="alert">{error}</p>}
          {plan?.upToDate ? (
            <p>This draft already includes the latest published content.</p>
          ) : (
            plan && (
              <>
                {plan.clean ? (
                  <p>Git merged the changes without conflicts.</p>
                ) : (
                  <>
                    <p>
                      Review Git’s conflicts and choose the final content for each file. “Keep
                      draft” and “Use published” select the entire file, including deletion when
                      that side has no file.
                    </p>
                    <ul>
                      {plan.messages
                        .filter((m) => m.type.startsWith("CONFLICT"))
                        .map((m, i) => (
                          <li key={i}>{m.message}</li>
                        ))}
                    </ul>
                  </>
                )}
                {plan.conflicts.map((path) => (
                  <section className="merge-file" key={path}>
                    <h3>{path}</h3>
                    <Button disabled={busy} variant="outline" onClick={() => inspect(path)}>
                      Compare versions
                    </Button>
                    {files[path] && (
                      <div className="merge-sources">
                        {(["base", "ours", "theirs", "merged"] as const).map((side) => (
                          <Collapsible key={side}>
                            <CollapsibleTrigger
                              render={<Button variant="ghost" className="disclosure-trigger" />}
                            >
                              {
                                {
                                  base: "Original",
                                  ours: "Your draft",
                                  theirs: "Published",
                                  merged: "Git merge with conflict markers",
                                }[side]
                              }
                            </CollapsibleTrigger>
                            <CollapsibleContent>
                              <pre>{show(files[path][side])}</pre>
                            </CollapsibleContent>
                          </Collapsible>
                        ))}
                      </div>
                    )}
                    <Label>
                      Resolution for {path}
                      <SelectField
                        label="Conflict resolution"
                        value={
                          choices[path]
                            ? "side" in choices[path]
                              ? choices[path].side
                              : "source" in choices[path]
                                ? "custom"
                                : "delete"
                            : ""
                        }
                        disabled={busy}
                        onValueChange={(value) => {
                          const v = value;
                          setChoices((c) => {
                            const next = { ...c };
                            if (!v) delete next[path];
                            else
                              next[path] =
                                v === "custom"
                                  ? { path, source: files[path]?.merged?.source ?? "" }
                                  : v === "delete"
                                    ? { path, delete: true }
                                    : { path, side: v as "ours" | "theirs" };
                            return next;
                          });
                        }}
                        options={[
                          { value: "", label: "Choose resolution" },
                          { value: "ours", label: "Keep draft" },
                          { value: "theirs", label: "Use published" },
                          {
                            value: "custom",
                            label: "Edit merged text",
                            disabled: !files[path]?.merged?.source,
                          },
                          { value: "delete", label: "Delete file" },
                        ]}
                      />
                    </Label>
                    {choices[path] && "source" in choices[path] && (
                      <Textarea
                        aria-label={`Resolved source for ${path}`}
                        disabled={busy}
                        value={(choices[path] as { source: string }).source}
                        onChange={(e) =>
                          setChoices((c) => ({ ...c, [path]: { path, source: e.target.value } }))
                        }
                      />
                    )}
                  </section>
                ))}
                {!plan.clean && (
                  <Label>
                    <Checkbox checked={confirmed} disabled={busy} onCheckedChange={setConfirmed} />{" "}
                    I reviewed Git’s conflict messages and the selected resolutions.
                  </Label>
                )}
                <Button
                  disabled={
                    busy || (!plan.clean && !confirmed) || plan.conflicts.some((p) => !choices[p])
                  }
                  onClick={apply}
                >
                  {busy ? "Updating…" : "Update draft and request fresh review"}
                </Button>
              </>
            )
          )}
          <Button variant="outline" disabled={busy} onClick={start}>
            Refresh merge plan
          </Button>
          <DialogClose disabled={busy} render={<Button variant="ghost" />}>
            Close
          </DialogClose>
        </DialogContent>
      </Dialog>
    </>
  );
}
