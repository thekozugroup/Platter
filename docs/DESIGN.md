# Platter design language

This is the contract for the interface. It exists so screens built at different times by
different people still feel like one product.

Platter's visual identity is the **Ghost design system** — minimal, warm-editorial, with a
retro-gaming twist. Near-pure-white canvas, near-black _pixelated_ display headings, clean
neutral-grey body sans, hairline dividers, and one signature frosted-glass floating pill.

Three sources, in priority order when they disagree:

1. **`apps/web/src/styles/tokens.css`** — the machine-readable truth. Every colour, size,
   radius, duration and material. If you are writing a raw hex value or an arbitrary pixel
   size, the token you need either exists or should be added there.
2. **This document** — the rules the tokens cannot express.
3. **Apple HIG** — supplies structure only: semantic roles, the spacing grid, 44px hit
   targets, motion that explains rather than decorates.

---

## 1. Components: Shark UI

The interface is assembled from [Shark UI](https://shark.vini.one) — 95 shadcn-style
components on Ark UI and Tailwind v4, already installed under `apps/web/src/components/ui/`.
A local reference for the whole registry is at `docs/reference/shark-ui-llms.txt`.

**Use the Shark component before writing your own.** The registry already covers Chart,
Sidebar, Command, Status, Table, Data List, File Upload, Tree View, QR Code, Bottom
Navigation, Steps, Tour, Field, Combobox, Toast and much more. A hand-rolled equivalent will
be less accessible, less consistent, and will not inherit the theme.

Shark components read shadcn's semantic variables (`--background`, `--foreground`,
`--primary`, `--muted`, `--border`, `--ring`, `--card`, `--sidebar-*`, `--chart-*`, plus
Shark's `--success` / `--warning` / `--info`). Those variables are **already mapped onto the
Ghost palette** at the bottom of `global.css`. This means:

- Components inherit the brand automatically. Do not restyle them one by one.
- To change the brand, change the mapping — not 95 files.
- Adding a component later (`pnpm dlx shadcn@latest add @shark/<name>`) gets themed for free.

Modify a file in `components/ui/` only to fix a real bug, never to apply per-screen styling.
Screen-specific composition lives in `components/<feature>/`.

---

## 2. Colour

**There is no chromatic brand accent.** This is the rule most likely to be broken by accident
and the one that most defines the look. Colour comes from game key-art; the chrome stays
monochrome. The focus ring is near-black. "Primary" is near-black, not blue.

| Role          | Value              | Use                             |
| ------------- | ------------------ | ------------------------------- |
| Canvas        | `#ffffff`          | Page background                 |
| Ink           | `#111111`          | Headings, primary text          |
| Grey dark     | `#333333`          | Strong secondary text           |
| Grey mid      | `#555555`          | Default body text               |
| Grey light    | `#777777`          | Tertiary, captions              |
| Grey border   | `#dddddd`          | Visible hairlines               |
| Border subtle | `rgba(0,0,0,0.06)` | Near-invisible dividers         |
| Primary fill  | `#161616`          | The one primary action per view |
| Primary label | `#f7f7f7`          | **Off-white, not pure white**   |

The warm off-whites — stone `#f7f4ef`, cream `#faf8f5`, ember `#f5ebe0`, sand `#faf9f7` — are
_surface tints_, not colours. They warm the sidebar and hovered rows. Never flood a page with
them and never use one to mean something.

**Two deliberate deviations from the Ghost brand spec**, both documented in `tokens.css`:

- **Functional status colour.** A control panel has to signal running / starting / crashed at
  a glance. Green, amber and red appear _only_ as status, in a muted register:
  green = `running`; amber = `starting`/`stopping`/`restarting`/`installing`;
  red = `crashed`/`install_failed`; grey = `offline`/`suspended`.
- **An opt-in dark theme.** Light is canonical and the default. Dark inverts the same
  monochrome ramp. The console is dark in both.

**Colour is never the only signal.** Around 4% of the people using this are red-green
colourblind. Every status carries a label, and the running dot pulses while the crashed dot
is a filled ring.

Contrast: body text meets **WCAG AA (4.5:1)**; large text and UI boundaries meet 3:1. Ghost's
grey ramp is tuned for an editorial page — `#777777` on white is _below_ AA at body size, so
tertiary grey is for genuinely non-essential text only, never for information available
nowhere else.

---

## 3. Typography

A deliberate **two-typeface system**, self-hosted from the `geist` npm package so an
air-gapped install renders identically.

- **`Geist Pixel Square`** — the chunky pixel display face. **Headings only** (`h1`–`h3`).
  Always weight 500; heavier fills in the pixel blocks and turns to mush. Tight tracking
  (`-0.025em` at 60px) and 1:1 leading are what give it the compact terminal look.
- **`Geist Sans`** — everything else: body, UI, buttons, labels, card titles.
- **`Geist Mono`** — IPs, ports, ids, file contents, the console.

**Never set body copy in the pixel face** — it is unreadable at 16px. **Never set a page
heading in the sans face.** Mixing the two within one role is the fastest way to make the
system look accidental.

| Role                 | Size        | Face  | Weight          |
| -------------------- | ----------- | ----- | --------------- |
| Display              | 60px        | Pixel | 500             |
| Title 1              | 36px        | Pixel | 500             |
| Title 2              | 24px        | Pixel | 500             |
| Title 3 / card title | 20px        | Sans  | 600             |
| Body large           | 18px / 28px | Sans  | 400             |
| Body                 | 16px        | Sans  | 400             |
| Subhead / label      | 14px        | Sans  | 400–500         |
| Caption              | 12px        | Sans  | 400–500         |
| Caption 2            | 11px        | Sans  | 500 — the floor |

Numbers that change in place — timers, byte counts, CPU percentages, player counts — use
`font-variant-numeric: tabular-nums`, or the layout jitters on every tick.

---

## 4. Shape, elevation, and the one glass surface

**Radius is the system's defining tension: interactive chrome is heavily rounded, content
imagery is sharp.**

- Buttons: `32px` — a compact pill.
- Floating nav: fully round.
- Cards and panels: `12px` (`--pl-radius-md`); `18px` for large feature cards.
- **Game key-art: `0px`.** Full-bleed, square corners. Rounding key-art breaks the
  square-versus-pill contrast the whole system rests on.

**Elevation is nearly absent.** Hairlines separate surfaces; shadow is reserved for things
that genuinely float. All shadows are black at 5–8% alpha:

- Card hover lift: `0 8px 24px rgba(0,0,0,0.08)` plus `translateY(-2px)`.
- Floating nav: `0 10px 15px -3px rgba(0,0,0,0.05), 0 4px 6px -4px rgba(0,0,0,0.05)`.

Never a heavy, large-blur, or coloured shadow.

**Frost is one surface, not a style.** The signature is a fully-round floating pill — white at
80% over `backdrop-filter: blur(8px)` with a 1px `rgba(0,0,0,0.06)` edge. Beyond that pill and
the occasional modal, surfaces are flat.

Specifically banned, because they are the _liquid glass_ signature this design is not:
specular edge gradients, inner rim lights or glow, refraction/lensing, and barely-there tints.
Frost here is frosted acrylic — tinted and opaque enough to read text on unaided.

Never put `backdrop-filter` on anything that repeats. It forces a compositing layer and
repaints as content scrolls behind it; a grid of 40 frosted cards drops frames on a laptop.

`prefers-reduced-transparency` collapses blur to zero and the tint to a solid surface — the
tokens already handle it.

---

## 5. Layout and spacing

- **8px base grid.** Every margin, padding and gap is a token: 4, 8, 12, 16, 24, 32, 48, 64, 112. An 11px gap is a bug.
- Content column caps at **1180px**, centred. Gutters 24px mobile / 48px desktop.
- Only game key-art goes full-bleed — never body text.
- **Hit targets are 44×44px minimum.** A 32px icon button needs padding or the `.hit-target`
  utility to reach it. This is the most commonly violated rule in this guide — check every
  icon button you write.
- Generous vertical rhythm: ~96–128px between major sections. The airiness is a defining
  trait; do not compress it to fit more in.
- Breakpoints: `<768px` phone (sidebar becomes a sheet, tables become cards, bottom
  navigation appears), `768–1279px` tablet (sidebar collapses to icons), `≥1280px` desktop.
- Layout is a fixed sidebar + fixed header + one scrolling content region. Chrome never moves.

---

## 6. Iconography

**[pixelarticons](https://pixelarticons.com/)**, installed at
`apps/web/node_modules/pixelarticons` — 877 icons as SVG and as React components
(`import Icon from 'pixelarticons/react/Server.js'`). The pixel-art style is the deliberate
partner to the pixel display face; a smooth outline set would fight it.

Use icons sparingly and functionally — navigation, actions, status. Ghost's own aesthetic is
icon-light and text-led, so an icon should be earning its place rather than decorating. Never
an icon alone where a word would be clearer, and every icon-only button carries an
`aria-label`.

---

## 7. Motion

Motion explains what happened — where a thing came from, what it became. Decorative animation
is worse than none.

- 150ms for hover and focus; 220ms for the common transition; 320ms for a sheet or full-screen
  change. Nothing routine exceeds 320ms.
- Standard easing `cubic-bezier(0.4, 0, 0.2, 1)`. **No bouncy or overshoot easing anywhere** —
  Ghost is explicit about this.
- **Animate only `transform` and `opacity`.** Animating width, height, top or box-shadow
  triggers layout or paint every frame and visibly stutters.
- Popovers scale from their trigger's corner via `transform-origin`, not from their own centre.
- **One ambient animation, at most.** No parallax, no marquees, no autoplay.
- `prefers-reduced-motion` is honoured everywhere. Tokens collapse durations to 1ms, but a
  transform-based entrance still needs a guard to become a plain fade — a 1ms scale-from-95% is
  a flash, exactly what motion-sensitive users are avoiding. Remove the movement, never the
  state change.

---

## 8. Interaction states

Every interactive element defines all six. Missing states are the difference between an
interface that feels finished and one that feels like a prototype.

1. **Rest**
2. **Hover** — surface warms one step. Pointer devices only (`@media (hover: hover)`), or
   touch devices get a sticky hover that never clears.
3. **Focus-visible** — 2px near-black ring at 2px offset. Never `outline: none` without a
   replacement.
4. **Active** — `scale(0.97)`. The scale is what makes a click feel physical.
5. **Disabled** — 40% opacity, `cursor: not-allowed`, and **always accompanied by why** — in a
   tooltip if nowhere else.
6. **Loading** — the control keeps its width and swaps its label for a spinner. A button that
   shrinks mid-submit moves everything under it.

---

## 9. Feedback, and being honest

- **Optimistic where it is safe, honest where it is not.** Renaming a server updates instantly
  and rolls back on failure. Starting a server does not pretend — it shows the real `starting`
  state, because lying about a 30-second operation is worse than waiting.
- **Skeletons, not spinners**, for content with a known shape.
- **Destructive actions confirm, naming what is lost.** "Delete server" is not a confirmation.
  "Delete _Survival SMP_? Its world data and 4 backups are permanently deleted" is.
- **Errors are actionable**: what happened, why, what to do.
- **Empty states teach.** An empty server list is the best moment to explain what Platter does
  and offer the primary action.
- **The AI proposes; the human decides.** Mod proposals from an agent show the full mod detail
  — description, images, author, license, downloads, dependencies — and require explicit
  approval. Never let a screen imply an agent action already took effect when it has not.
- **A person acting for themselves is not asked to approve their own decision.** Pressing "Add
  to \<server\>" installs. The confirmation step exists for _surprises_ — extra dependencies, a
  version other than the one on screen — and appears only when the resolved plan contains one.
  A gate that fires every time teaches people to click through it, which costs the gate its
  meaning on the one occasion it mattered. The two paths must stay visibly distinct: browsing
  reads as _you are doing this_, a proposal reads as _someone suggested this for you_.

---

## 10. Accessibility floor

Non-negotiable, and specifically audited:

- Everything reachable and operable by keyboard, in a sensible tab order.
- Visible focus on everything focusable.
- Dialogs trap focus, close on `Escape`, restore focus to their trigger.
- Icon-only buttons carry `aria-label`.
- `aria-live="polite"` announces async status changes — a server going from starting to
  running must be perceivable without watching a colour.
- Inputs have real `<label>`s; errors tie to their field via `aria-describedby` and
  `aria-invalid`.
- The console is `role="log"` with `aria-live="polite"` and must not steal focus as lines
  arrive.
- Charts are never the only representation of their data — pair every chart with the current
  value in text.
- Works at 200% browser zoom with no horizontal scrolling or clipped content.

---

## 11. Voice

Plain, specific, calm — and confident enough to name real mechanics. Ghost writes
"Your VM, your token, your billing", not "seamless cloud orchestration".

- Terse declarative fragments. Imperative triads where they fit: _Pick a game. Pick a region.
  Press play._
- Second person, active voice. Sentence case everywhere — headings, buttons, labels.
- Buttons are verbs: "Create server", not "Submit". "Delete backup", not "OK".
- Name the real thing — Docker, RCON, a port, a mod loader — rather than a marketing
  abstraction. The people self-hosting a game server are not afraid of the words.
- Say what happened, not how the system feels about it. "Couldn't reach the node" beats
  "Oops! Something went wrong 😕".
- Never blame the user. Never apologise twice.
- Numbers get units and separators. Times are relative under a week, absolute beyond it,
  always with the exact timestamp in a tooltip.
