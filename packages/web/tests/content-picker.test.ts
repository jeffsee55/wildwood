import { afterEach, expect, test, vi } from "vitest";
import { installContentPicker } from "../browser/content-picker";

class PageElement {
  isConnected = true;
  constructor(readonly mapped: PageElement | null = null) {}
  closest() {
    return this.mapped;
  }
  querySelector() {
    return null;
  }
}
afterEach(() => vi.unstubAllGlobals());
function fixture() {
  vi.stubGlobal("Element", PageElement);
  const owner = new EventTarget();
  const host = { ownerDocument: owner } as unknown as HTMLElement;
  const select = vi.fn(),
    add = vi.fn(),
    cancel = vi.fn(),
    pageHandler = vi.fn();
  const cleanup = installContentPicker({ host, onSelect: select, onAdd: add, onCancel: cancel });
  const dispatch = (type: string, target: PageElement, properties = {}, inToolbar = false) => {
    const event = new Event(type, { cancelable: true });
    Object.defineProperties(event, {
      target: { value: target },
      composedPath: { value: () => (inToolbar ? [target, host, owner] : [target, owner]) },
      button: { value: 0 },
      ...Object.fromEntries(Object.entries(properties).map(([name, value]) => [name, { value }])),
    });
    owner.addEventListener(type, pageHandler, { once: true });
    owner.dispatchEvent(event);
    return event;
  };
  return { dispatch, select, add, cancel, pageHandler, cleanup };
}

test("picking consumes mapped and unmapped page links, including middle clicks and pointer handlers", () => {
  const f = fixture();
  const mapped = new PageElement();
  const child = new PageElement(mapped);
  for (const type of [
    "pointerdown",
    "pointerup",
    "mousedown",
    "mouseup",
    "click",
    "dblclick",
    "contextmenu",
    "auxclick",
  ]) {
    expect(f.dispatch(type, child).defaultPrevented).toBe(true);
    expect(f.dispatch(type, new PageElement(), { button: 1 }).defaultPrevented).toBe(true);
  }
  expect(f.select).toHaveBeenCalledExactlyOnceWith(mapped);
  expect(f.pageHandler).not.toHaveBeenCalled();
});

test("toolbar controls remain interactive and disabling selection restores normal page links", () => {
  const f = fixture();
  expect(f.dispatch("click", new PageElement(), {}, true).defaultPrevented).toBe(false);
  expect(f.pageHandler).toHaveBeenCalledOnce();
  f.cleanup();
  expect(f.dispatch("click", new PageElement()).defaultPrevented).toBe(false);
  expect(f.pageHandler).toHaveBeenCalledTimes(2);
});

test("keyboard link activation selects without navigating and Command L adds the connected selection", () => {
  const f = fixture();
  const mapped = new PageElement();
  expect(f.dispatch("keydown", new PageElement(mapped), { key: "Enter" }).defaultPrevented).toBe(
    true,
  );
  expect(
    f.dispatch("keydown", new PageElement(), { key: "l", metaKey: true }).defaultPrevented,
  ).toBe(true);
  expect(f.add).toHaveBeenCalledExactlyOnceWith(mapped);
  mapped.isConnected = false;
  expect(
    f.dispatch("keydown", new PageElement(), { key: "l", metaKey: true }).defaultPrevented,
  ).toBe(false);
  expect(f.dispatch("keydown", new PageElement(), { key: "Escape" }).defaultPrevented).toBe(true);
  expect(f.cancel).toHaveBeenCalledOnce();
});
