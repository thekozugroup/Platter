# Platter design language

This is the contract for the interface. It exists so that screens built at different
times by different people still feel like one product.

Two influences, deliberately combined:

- **Apple's Human Interface Guidelines** for *structure* — semantic type and colour roles,
  a strict spacing grid, generous hit targets, motion that explains rather than decorates,
  and a strong bias toward deference: the chrome recedes, the content is the interface.
- **Android 17 frost** for *materials* — translucent surfaces that are frosted acrylic,
  not lenses.

Everything below is enforced by `apps/web/src/styles/tokens.css`. If you find yourself
writing a raw hex value, a one-off pixel size or a bespoke shadow, the token you need
either exists or should be added there.

---

## 1. Frost, not liquid glass

This is the single most load-bearing visual decision, so it gets the most words.

Apple's liquid glass simulates a lens: light refracts through it, edges pick up a specular
highlight, and content behind it distorts. Platter deliberately does **not** do that.
Platter uses the Android 17 treatment: a **frosted, tinted, flat-edged** surface.

**A frost surface is:**

| Property | Value |
| --- | --- |
| Backdrop | `blur()` at one of four levels, plus `saturate(1.7)` to stop colour washing out |
| Tint | A translucent surface colour *over* the blur — around 72% opacity, not 20% |
| Border | A single flat hairline, uniform on all four sides |
| Shadow | Two soft layers (tight key + wide ambient) |
| Corners | Large radii — `--pl-radius-lg` and up for anything panel-sized |

**A frost surface is never:**

- ❌ **Edge specular highlights** — no `linear-gradient` "sheen" along the top edge, no
  brighter border on one side than another. That is the liquid-glass tell.
- ❌ **Rim lights or inner glow** — no `inset` box-shadows simulating light catching an edge.
- ❌ **Refraction or lensing** — no backdrop scaling, no displacement, no chromatic edges.
- ❌ **Barely-there tint** — a 20%-opacity surface over a blur is glass. Frost is opaque
  enough to read text on without a second scrim.

Four levels, matching the token names:

- `frost-thin` (`12px`) — inline chips, hovering toolbars over content.
- `frost-regular` (`24px`) — cards, popovers, dropdowns. The default.
- `frost-thick` (`40px`) — sheets, dialogs, anything that takes focus from the page.
- `frost-chrome` (`56px`) — the app header and sidebar, which sit above scrolling content.

**Frost is not free.** `backdrop-filter` forces a compositing layer and repaints as content
scrolls behind it. Use it on chrome and overlays — surfaces that are few and long-lived.
Do **not** put it on list items, table rows, or anything rendered N times: a grid of 40
frosted cards will drop frames on a laptop. Those get a solid `--pl-surface` instead.

Honour `prefers-reduced-transparency`: the tokens already collapse blur to `0` and the
tint to a solid colour, so a correctly-built component needs no extra work.

---

## 2. Typography

Use the semantic roles, not sizes. `--pl-text-headline` says what the text *is*; `15px`
says only how big it is, and will drift.

| Role | Size | Weight | Used for |
| --- | --- | --- | --- |
| `display` | 34px | 700 | One per screen at most — the page title |
| `title-1` | 28px | 700 | Major section heads |
| `title-2` | 22px | 600 | Card and panel titles |
| `title-3` | 18px | 600 | Subsection heads |
| `headline` | 16px | 600 | Emphasised body, list item titles |
| `body` | 16px | 400 | Default reading text |
| `callout` | 15px | 400 | Slightly de-emphasised body |
| `subhead` | 14px | 400/500 | Form labels, table headers, metadata |
| `footnote` | 13px | 400 | Helper text under inputs |
| `caption` | 12px | 400/500 | Timestamps, badge text, axis labels |
| `caption-2` | 11px | 500 | The floor. Nothing smaller ships. |

Rules:

- **Never below 11px**, and 11px only for non-essential secondary text.
- Large text gets negative tracking (`--pl-tracking-display`), small text gets positive.
  This is not optional polish; untracked 34px text looks visibly loose.
- Line height 1.5 for prose, 1.3 for headings, 1.15 for single-line display text.
- Numbers that change in place — timers, byte counts, CPU percentages — use
  `font-variant-numeric: tabular-nums`, or the layout jitters every tick.
- Monospace (`--pl-font-mono`) for: the console, file contents, IDs, ports, addresses.

---

## 3. Colour

Reference **semantic** tokens (`--pl-label-secondary`), never ramp tokens
(`--ramp-neutral-600`) and never raw values. Every semantic token is defined in both
themes; a component that uses only semantic tokens is automatically theme-correct.

**Text emphasis has exactly four levels** — `label`, `label-secondary`, `label-tertiary`,
`label-quaternary`. If you want a fifth, you actually want a different layout.

**Status colours are fixed vocabulary.** They mean one thing each, everywhere:

| Status | Token | Server states |
| --- | --- | --- |
| Green | `--pl-success` | `running` |
| Amber | `--pl-warning` | `starting`, `stopping`, `restarting`, `installing` |
| Red | `--pl-danger` | `crashed`, `install_failed` |
| Grey | `--pl-neutral-status` | `offline`, `suspended` |
| Violet | `--pl-accent` | Brand, selection, focus — **never** a status |

The accent is violet precisely so it can never be confused with a status. Do not use it to
mean "good".

**Colour is never the only signal.** Around 4% of the people using this are red-green
colourblind, and a status dot that differs only in hue tells them nothing. Every status
carries a shape or a label too: the running dot pulses, the crashed dot is a filled ring,
and all of them sit next to a word.

Contrast: body text meets **WCAG AA (4.5:1)**, large text and UI boundaries meet 3:1.
Tertiary and quaternary labels are for non-essential text only — they do not meet AA at
body size and must never carry information available nowhere else.

---

## 4. Layout and spacing

- **4pt grid.** Every margin, padding and gap is a `--pl-space-*` token. An `11px` gap is
  a bug.
- **Hit targets are 44×44px minimum.** A 32px-tall icon button is fine *visually*, but it
  needs padding or a pseudo-element to reach 44px of touchable area. This is the most
  commonly violated rule in the guide — check it on every icon button you write.
- Content maxes out at `--pl-content-max` (1440px) and stays centred. Full-bleed text at
  2560px is unreadable.
- Breakpoints: `< 768px` phone (sidebar becomes a sheet, tables become cards),
  `768–1279px` tablet (sidebar collapses to icons), `≥ 1280px` desktop.
- The layout is a fixed sidebar + fixed header + scrolling content region. Only the content
  region scrolls; chrome never moves.

---

## 5. Motion

Motion exists to explain what just happened — where a thing came from, what it became.
Decorative animation is worse than none.

- Durations come from tokens; `--pl-duration-fast` (140ms) for hover and press feedback,
  `--pl-duration-normal` (220ms) for the common transition, `--pl-duration-slow` (320ms)
  for a full-screen or sheet transition. Nothing routine exceeds 320ms.
- `--pl-ease-standard` for most things, `--pl-ease-out` for entrances,
  `--pl-ease-spring` for direct manipulation (drag, toggle, sheet drag-to-dismiss).
- **Animate only `transform` and `opacity`.** Animating `width`, `height`, `top` or
  `box-shadow` triggers layout or paint every frame and will visibly stutter.
- Things scale *from where they came from*: a popover opens from its trigger's corner
  (`transform-origin`), not from its own centre.
- **`prefers-reduced-motion` is honoured everywhere.** The tokens collapse durations to
  1ms, but transform-based entrances still need a `@media` guard to become a plain fade —
  a 1ms scale-from-95% is a flash, which is exactly what motion-sensitive users are
  avoiding. Never remove the state change, only the movement.

---

## 6. Interaction states

Every interactive element defines all six. Missing states are the difference between an
interface that feels finished and one that feels like a prototype.

1. **Rest**
2. **Hover** — surface lifts one step (`--pl-surface-hover`). Pointer devices only
   (`@media (hover: hover)`), or touch devices get a sticky hover that never clears.
3. **Focus-visible** — a 2px `--pl-accent-ring` at 2px offset. Never `outline: none`
   without a replacement; keyboard users navigate entirely by this ring.
4. **Active/pressed** — `scale(0.97)` plus a darker surface. The scale is what makes a
   click feel physical.
5. **Disabled** — 40% opacity, `cursor: not-allowed`, and `aria-disabled` rather than the
   `disabled` attribute where the element still needs to be focusable to explain itself.
   A disabled control must always be accompanied by *why* — in a tooltip if nowhere else.
6. **Loading** — the control keeps its size and swaps its label for a spinner. A button
   that shrinks mid-submit moves everything under it.

---

## 7. Feedback and empty states

- **Optimistic where it's safe, honest where it isn't.** Renaming a server updates
  instantly and rolls back on failure. Starting a server does not pretend — it shows the
  real `starting` state, because lying about a 30-second operation is worse than waiting.
- **Skeletons, not spinners**, for content that has a known shape. Spinners only for
  indeterminate waits under ~1s.
- **Destructive actions confirm**, and the confirmation names the thing being destroyed
  and what is lost. "Delete server" is not a confirmation; "Delete *Survival SMP*? Its
  world data and 4 backups are permanently deleted" is.
- **Errors are actionable.** State what happened, why, and what to do. The error codes in
  `@platter/shared` map to human copy in `ERROR_MESSAGES` — start there, then add context.
- **Empty states teach.** An empty server list is the best moment to explain what Platter
  does and offer the primary action. A grey "No data" is a wasted screen.

---

## 8. Accessibility floor

Non-negotiable, and specifically audited:

- Every interactive element reachable and operable by keyboard, in a sensible tab order.
- Visible focus on everything focusable.
- Dialogs trap focus, close on `Escape`, and restore focus to their trigger on close.
- Icon-only buttons carry an `aria-label`.
- Live regions (`aria-live="polite"`) announce status changes — a server going from
  starting to running must be perceivable without watching a colour.
- Form inputs have real `<label>`s; errors are tied to their field with `aria-describedby`
  and `aria-invalid`.
- The console is a log view: `role="log"` with `aria-live="polite"`, and it must not steal
  focus when new lines arrive.
- Nothing conveys meaning through colour alone.
- Tested at 200% browser zoom without horizontal scrolling or clipped content.

---

## 9. Voice

Interface copy is plain, specific and calm.

- Say what happened, not how the system feels about it. "Couldn't reach the node" beats
  "Oops! Something went wrong 😕".
- Second person, active voice, no jargon where a normal word exists.
- Sentence case for everything — headings, buttons, labels. Not Title Case.
- Buttons are verbs: "Create server", not "Submit". "Delete backup", not "OK".
- Never blame the user. Never apologise more than once.
- Numbers get units and thousands separators. Times are relative under a week
  (`4 minutes ago`) and absolute beyond it, always with the exact timestamp in a tooltip.
