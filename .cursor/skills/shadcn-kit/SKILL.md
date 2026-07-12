---
name: shadcn-kit
description: >-
  Add and use shadcn/ui components in @wildwood/kit (base-mira, Tailwind v4). Use when
  adding UI primitives, theming dropdowns/menus, or portaling into the Kit shadow tree.
---

# shadcn/ui in `packages/kit`

## CLI

Always run from the kit package root:

```bash
cd packages/kit
pnpm dlx shadcn@latest add <component>
```

Registry and style are defined in `packages/kit/components.json` (`style: base-mira`, `cssVariables: true`, `baseColor: olive`, aliases `@/components/ui`, etc.). New files land under `src/components/ui/`.

You can also use `pnpm shadcn add <component>` (script in `package.json`).

After adding components or new Tailwind class names, run **`pnpm build`** in `packages/kit` so `dist/index.js` embeds an up-to-date compiled stylesheet (`index.css` uses `@source` + `tsdown` runs Tailwind on each build). Host apps (e.g. Next) consume `dist`, not Vite’s dev CSS pipeline.

## After adding a component

1. Import from `@/components/ui/...` (path alias used throughout kit).
2. Prefer theme tokens via Tailwind: `bg-popover`, `text-popover-foreground`, `border-border`, `bg-accent`, etc. (see `src/index.css`).
3. **Shadow DOM / floating UI**: menus, popovers, and dialogs portal to `document.body` by default. Inside `ShadowRoot`, pass the portal node from `useShadowContainer()` into the generated primitive when supported — e.g. `DropdownMenuContent` accepts `container={useShadowContainer() ?? undefined}`. Light-DOM-only styles do not apply inside shadow; anything portaled outside the shadow tree will look unstyled.

4. **Positioning**: The shadow host in the light DOM can be zero-sized. Prefer `absolute` + offsets for overlays pinned to the viewport, anchored to the inner full-screen wrapper (`useShadowContainer()`), rather than `fixed`, which often resolves against the host and ends up top-left.

## Stack note

This project’s shadcn registry uses **Base UI** primitives (`@base-ui/react`), not Radix. Triggers often use a `render={<YourElement />}` prop instead of Radix `asChild`.
