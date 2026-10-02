import { Textarea } from "./ui/textarea";
import { Component, lazy, Suspense, type ReactNode, type ComponentProps } from "react";
const MarkdownEditor = lazy(() => import("./markdown-editor"));
class EditorBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
export function Editor(props: ComponentProps<typeof MarkdownEditor>) {
  const fallback = (
    <>
      <p className="hint" role="status">
        Rich editor unavailable. Your source is still editable.
      </p>
      <Textarea
        aria-label="Document source"
        value={props.source}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.target.value)}
      />
    </>
  );
  return (
    <EditorBoundary fallback={fallback}>
      <Suspense
        fallback={
          <p className="editor-loading" role="status">
            Opening editor…
          </p>
        }
      >
        <MarkdownEditor {...props} />
      </Suspense>
    </EditorBoundary>
  );
}
