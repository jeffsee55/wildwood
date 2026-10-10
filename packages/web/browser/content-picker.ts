import { isContentShortcut } from "./content-context";

/** Own page interactions during picking; toolbar controls and scrolling remain available. */
export function installContentPicker({
  host,
  onSelect,
  onAdd,
  onCancel,
}: {
  host: HTMLElement;
  onSelect: (element: Element) => void;
  onAdd: (element: Element) => void;
  onCancel: () => void;
}) {
  const owner = host.ownerDocument;
  let selected: Element | null = null;
  const outside = (event: Event) => !event.composedPath().includes(host);
  const pick = (target: EventTarget | null) => {
    if (!(target instanceof Element)) return;
    const element =
      target.closest("[data-ww-contentmap]") ?? target.querySelector("[data-ww-contentmap]");
    if (!element || element === selected) return;
    selected = element;
    onSelect(element);
  };
  const block = (event: Event) => {
    if (!outside(event)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (
      (event.type === "pointerdown" || event.type === "click") &&
      (event as MouseEvent).button === 0
    )
      pick(event.target);
  };
  const key = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopImmediatePropagation();
      onCancel();
      return;
    }
    if (selected?.isConnected && isContentShortcut(event)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      onAdd(selected);
      return;
    }
    if (outside(event) && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      event.stopImmediatePropagation();
      pick(event.target);
    }
  };
  const events = [
    "pointerdown",
    "pointerup",
    "mousedown",
    "mouseup",
    "click",
    "auxclick",
    "dblclick",
    "contextmenu",
  ];
  for (const name of events) owner.addEventListener(name, block, { capture: true, passive: false });
  owner.addEventListener("keydown", key, { capture: true });
  return () => {
    for (const name of events) owner.removeEventListener(name, block, { capture: true });
    owner.removeEventListener("keydown", key, { capture: true });
  };
}
