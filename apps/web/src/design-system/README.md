# Astra design system

Agent 01 (Creative Direction and UI)'s token set, motion system and primitive component library
for the **Astra** 3D-laboratory expansion (`/lab`). It is deliberately independent of the existing
v1 application's `styles/app.css` / `styles/lab.css` and `ui/kit.tsx` — no shared runtime, no shared
CSS custom properties — so the two experiences can be developed, reviewed and shipped without
either one risking the other. See [`../lab/shell/README.md`](../lab/shell/README.md) for how this
system is composed into the lab shell itself, and for the integration contract with Agents 02–09.

## Why a second design language

The v1 app already has a dark, teal-accented identity (`--bg`, `--accent`, `.ml-*`). Astra's brief
asks for its own "Awwwards-caliber" identity, not a reskin, so this system:

- Uses a **namespaced** token and class vocabulary (`--astra-*` custom properties, `astra-*` class
  names) so it can never collide with or accidentally override the v1 app's styles, even if both
  were ever rendered in the same document.
- Reuses the three variable font families the app already downloads (Space Grotesk, Inter,
  JetBrains Mono) rather than adding new font weight — originality here comes from palette, scale,
  radii, motion and composition, not another web font request.
- Picks a **cool/warm lighting contrast** as the signature move: a cold "instrument-glass" blue
  (`--astra-cool-*`) for flow, selection and primary actions, and a warm "flame amber"
  (`--astra-warm-*`) reserved for energetic/affirmative emphasis, over a near-black midnight-navy
  base (`--astra-depth-*`).

## Files

| File | What it is |
| --- | --- |
| `tokens.css` | The source of truth: color, spacing, typography, radii, shadow/elevation, motion durations/easings, z-index. Import once near the root of any Astra tree. |
| `tokens.ts` | The handful of values JavaScript itself needs (breakpoints, numeric durations, the five-level `AstraEvidence` vocabulary and its color/label/description map). Keep in step with `tokens.css` by hand. |
| `motion.ts` | `prefersReducedMotion()` / `useReducedMotion()` (OS setting **or** the in-app toggle, see below), `duration()`, `transitionFor()`, `afterMotion()`. |
| `MotionViews.tsx` | `<Collapse>` (height-animated show/hide, content stays mounted) and `<Reveal>` (fade/lift on mount), both reduced-motion aware. |
| `primitives/` | `Button`/`IconButton`, `Panel`/`PanelHeader`/`Eyebrow`, `StatusBadge`/`EvidenceBadge`, `Segmented`, `Tabs`/`TabPanel`, `ProgressBar`/`Spinner`, `CollapsibleSection`, `SearchField`, `StatePanel`, `Modal`, `useDismiss`. Barrelled from `primitives/index.ts`. |
| `primitives.css` | Styles for everything above, plus small utilities (`astra-mono`, `astra-sep`, `astra-spin`, `astra-hide-narrow`, `astra-scroll`, the `[data-astra-tip]` pure-CSS tooltip). |

## Reduced motion

Two independent switches, both honoured everywhere:

1. The OS `prefers-reduced-motion: reduce` media feature.
2. An in-app toggle (Quality menu → "Reduce motion"), persisted to `localStorage` under
   `astra-lab:reduced-motion`, for users who want stillness here without changing their system
   setting.

`useReducedMotion()` reflects whichever is active; `initMotionPreference()` (call once at the root)
also sets `document.documentElement.dataset.astraMotion = 'reduced' | 'full'`, which
`tokens.css`/`primitives.css` use to collapse `--astra-duration-*` to `0ms` and stop decorative
`animation`s (the spinner slows rather than stops, so busy state is never silently invisible).

## Evidence levels

The shared integration contract's five-level vocabulary (`REFERENCE_MEASURED` / `MODEL_CALCULATED`
/ `ILLUSTRATIVE` / `UNVERIFIED` / `UNSUPPORTED`, `tokens.ts`'s `AstraEvidence`) is **not** the same
as `@matterlab/core`'s six-level `EvidenceLevel` used by the v1 Architect/Reactions/Vault
(`reference` / `computed` / `rule-based` / `illustrative` / `user-input` / `unsupported`). Lab
surfaces fed by Agent 06/07 observations use `<EvidenceBadge level={...} />` with the Astra
vocabulary; never invent a value outside of it, and never silently drop the badge next to a number.

## Usage example

```tsx
import { Button, EvidenceBadge, Panel, PanelHeader, StatePanel } from '../../design-system';

function ReadoutCard({ ph }: { ph: { value: number; evidence: AstraEvidence } | null }) {
  return (
    <Panel elevation="raised">
      <PanelHeader eyebrow="Live readout" title="pH" />
      {ph ? (
        <>
          <span>{ph.value.toFixed(2)}</span>
          <EvidenceBadge level={ph.evidence} />
        </>
      ) : (
        <StatePanel kind="empty" title="No reading yet" />
      )}
    </Panel>
  );
}
```

## Testing

Pure logic (`motion.ts`'s `duration`/`transitionFor`/the no-`window` fallback) is covered by
`motion.test.ts` with Vitest, following the project's existing convention of unit-testing logic and
leaving anything DOM-interactive to Playwright (see `apps/web/e2e/astra-lab.spec.ts` and
`astra-lab.shots.ts`).
