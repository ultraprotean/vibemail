# VibeMail Cozy — Design System

Token values live in `web/src/styles/` (`tokens.css`, `themes.css`, `patterns.css`, `app.css`). This document explains the intent so changes stay consistent. Behaviour is specified in `docs/DESIGN_SPEC.md`.

## Principles

- Behaviour before appearance: the spec defines states first; the visuals support them.
- The nostalgia lives in the chrome (borders, windows, display type, the hand cursor), never in the mail text.
- Colour supports reading. Every text and background pair keeps at least 4.5:1 contrast; non-text markers keep at least 3:1.
- Motion is decoration only, and one switch turns all of it off.

## Surfaces

Every panel (rows, thread messages, drawer, dialog, toasts, top bar) is a "window": a 3px border in `--border`, a 2px inner rim in `--rim`, a vertical gradient from `--surface-top` to `--surface`, and a paper-cutout shadow made of a hard offset (`--shadow-edge`) plus a soft blur (`--shadow-color`). Unread rows use `--surface-unread-top` / `--surface-unread`. Radii: 9px (controls), 14px (panels), 22px (drawer).

## Themes

| Theme | Inspiration | Mood | Accent |
|---|---|---|---|
| Hearthside (default) | Chrono Trigger village interiors | cream parchment, brown ink, amber lamplight | burnt amber on cream |
| Moonlit Window | Final Fantasy VI menu windows | twilight blue gradient windows with a pale rim | gold on navy |
| Meadow Paper | Paper Mario folded scenery | soft green paper with rose highlights | forest green, rose marker |

`--accent` carries buttons and selected chips; `--accent-ink` is the text on it. `--highlight` and `--marker` are decorative (unread dot, search highlight, sparkle). `--danger` marks errors and Discard. `--focus` is the keyboard focus ring.

## Patterns

Chosen in Settings and drawn on the fixed backdrop layer. Patterns stay quiet so they never compete with content.

| Pattern | What it is | Notes |
|---|---|---|
| Paper grain | Mottled parchment: large soft blotches over fine speckle | Visibly textured (unlike Plain); its drift is the gentlest, a slow slide of soft blotches |
| Gingham | Soft crossing stripes, 56 px repeat | Geometric and easy to see moving |
| Drifting clouds | Flat, puffy Paper-Mario-sky clouds cut from a tint with a mask, 360 px repeat | Reads as a sky sliding past; white-ish on the light themes, pale blue on Moonlit |
| Twinkling star-dust | Small, soft stars in the theme marker colour, 320 px repeat | Five groups of stars, each dipping from about 50% to 10% opacity on its own 5 to 11 second beat, so they wink out of step and nothing flashes |
| Plain | Just the gradient | Nothing to drift |

The old "Stitched quilt" was replaced by Drifting clouds because it looked too much like Gingham. A saved quilt choice becomes clouds.

### Random look ("Surprise me")

Each visit starts with a random theme, a random pattern (any except Plain) and a random drift: any of the eight compass directions or the big circle (with a random spin) at a gentle speed, levels 1 to 5 of 10. The drift on/off switch is never changed. The pick is made before first paint and remembered for the life of the browser tab, so a reload does not reshuffle. It is on for first-time visitors. Choosing any part of it yourself (theme, pattern, drift direction, speed or spin) turns it off, keeps your choice, and keeps everything else that was on screen; turning it off keeps what is on screen; turning it on, or pressing Shuffle now, picks a fresh look. Visitors who saved a look before this feature existed keep it.

### Background drift

The pattern layer slowly slides across the screen. By default it drifts down and to the right, slowly.

- **Settings (Background drift):** an on/off switch; a 3 by 3 direction pad with the eight compass arrows (the arrow is the way the background moves) and a big-circle button in the middle; a Clockwise / Counterclockwise choice when the circle is selected; and a speed slider from 1 (slowest) to 10 (fastest). Defaults: on, down and to the right, speed 2.
- **Speed:** each step is 4 px per second, so the default is a slow 8 px/s and the fastest is 40 px/s. Diagonals are normalized so every direction travels at the same speed along its path.
- **The big circle:** the pattern travels along a circle of 500 px radius, so at default speed one lap takes about 6.5 minutes and at top speed about 78 seconds.
- **Smooth changes:** the drift is a small physics loop, not a CSS animation (a CSS animation jumps when its duration or direction changes). Velocity eases toward its target with a 0.6 second time constant, so changing speed or direction, joining or leaving the circle, or switching drift on or off all glide. Reversing direction slows through a stop and turns around.
- **Seamless loop:** the layer is one tile larger than the screen on every side and its offset wraps by exactly one tile, moved with a compositor transform (no repainting). The loop pauses when nothing is moving. `PATTERN_TILES` in `src/lib/settings.ts` and `--tile` in `patterns.css` must agree (a test checks).
- **When it stops:** drift runs only when gentle animation is on, the device does not ask for reduced motion, the drift switch is on, and the pattern on screen is not Plain. Otherwise the controls are disabled and say why.

## Type

- Display (headings, brand, avatars, panel titles): Pixelify Sans, self-hosted via `@fontsource-variable/pixelify-sans`.
- Text (everything you read): Nunito, self-hosted via `@fontsource-variable/nunito`.
- Base size 16px, scaled by the Settings text-size choice (90 / 100 / 110%) through `--font-scale` on the root.

## Components

- Landing screen: a pair of launch buttons ("Sign in with Google" in the accent colour, "Try the sample inbox" quieter), each with a one-line note, separated by a dashed "or" rule. A small dashed "Sample" badge sits beside the brand while the sample inbox is open.
- Message row: avatar initials, sender (strong), time, subject, snippet. Unread: bold sender and subject, filled marker. The marker is also the read/unread toggle (44px target).
- Message body: HTML is the default view when a message has it (Plain is the default only when there is no HTML), with a Plain / HTML pill toggle above it. HTML renders in a white, script-less sandboxed frame. Remote images load by default; a Settings switch blocks them, and a blocked message offers "Load images for this message".
- Pointing hand: on wide screens with a hover device, a small pixel hand slides in beside the hovered or keyboard-focused row.
- Chips: pills with a 2px border; selected chips fill with `--accent`; disabled chips use a dashed border and explain why on hover and to screen readers.
- Compose drawer: bottom sheet on mobile (capped at 58% of the visual viewport, header and Send pinned), docked panel at the bottom right on desktop.
- Toasts: small windows above the New message button; Sent gets a one-time sparkle.

## Motion

Idle bob on unread markers; hand-cursor slide on row focus; slide-in when a thread opens; drawer and toast "settle"; send sparkle; twinkling stars; loading shimmer; slow background drift. Everything is disabled when `html[data-motion="off"]`, which the app sets when the Settings toggle is off or `prefers-reduced-motion` is on. A media query repeats the rule as a fallback.

## Mobile

- 12px side gutters, 44px minimum touch targets, label chips scroll horizontally in one row.
- The compose drawer follows the visual viewport (`--vv-h`, `--vv-bottom`), so the on-screen keyboard never leaves it taller than 58% of the visible area.
- Fixed controls respect `env(safe-area-inset-*)`.
