export const THEMES = ['hearthside', 'moonlit', 'meadow'] as const;
export type ThemeName = (typeof THEMES)[number];

export const PATTERNS = ['grain', 'gingham', 'clouds', 'stardust', 'none'] as const;
export type PatternName = (typeof PATTERNS)[number];

/** Patterns the random look picks among (everything except Plain). */
export const SHUFFLE_PATTERNS = ['grain', 'gingham', 'clouds', 'stardust'] as const;

/**
 * Repeat size of each pattern in pixels. The drift wraps by exactly this distance, so it must
 * match the `--tile` values in patterns.css (a test keeps them in step).
 */
export const PATTERN_TILES: Record<PatternName, number> = { grain: 240, gingham: 56, clouds: 360, stardust: 320, none: 0 };

export const FONT_SCALES = [90, 100, 110] as const;
export type FontScale = (typeof FONT_SCALES)[number];

/** Eight compass directions; the value is the way the background moves across the screen. */
export const COMPASS_DIRECTIONS = ['nw', 'n', 'ne', 'w', 'e', 'sw', 's', 'se'] as const;
export type CompassDirection = (typeof COMPASS_DIRECTIONS)[number];

/** The compass plus a big circle. */
export const DRIFT_DIRECTIONS = [...COMPASS_DIRECTIONS, 'circle'] as const;
export type DriftDirection = (typeof DRIFT_DIRECTIONS)[number];

export const DRIFT_SPINS = ['cw', 'ccw'] as const;
export type DriftSpin = (typeof DRIFT_SPINS)[number];

export const DRIFT_VECTORS: Record<CompassDirection, { dx: number; dy: number }> = {
  n: { dx: 0, dy: -1 },
  ne: { dx: 1, dy: -1 },
  e: { dx: 1, dy: 0 },
  se: { dx: 1, dy: 1 },
  s: { dx: 0, dy: 1 },
  sw: { dx: -1, dy: 1 },
  w: { dx: -1, dy: 0 },
  nw: { dx: -1, dy: -1 },
};

export const DRIFT_LABELS: Record<DriftDirection, string> = {
  n: 'up',
  ne: 'up and to the right',
  e: 'to the right',
  se: 'down and to the right',
  s: 'down',
  sw: 'down and to the left',
  w: 'to the left',
  nw: 'up and to the left',
  circle: 'in a big circle',
};

export const DRIFT_SPEED_MIN = 1;
export const DRIFT_SPEED_MAX = 10;
/** The random look keeps to the gentler half of the speed range. */
export const SHUFFLE_SPEED_MAX = 5;
/** Pixels per second for each speed step, so level 2 (the default) is a slow 8 px/s. */
export const DRIFT_PX_PER_SECOND_PER_LEVEL = 4;

export interface Settings {
  theme: ThemeName;
  pattern: PatternName;
  /** Subtle animation. Always effectively off under `prefers-reduced-motion`. */
  motion: boolean;
  fontScale: FontScale;
  /** Let the background pattern drift. Needs motion on and a pattern other than Plain. */
  drift: boolean;
  /** 1 (slowest) to 10 (fastest). */
  driftSpeed: number;
  driftDirection: DriftDirection;
  /** Which way round when the direction is the big circle. */
  driftSpin: DriftSpin;
  /** Fetch images from the sender's servers when showing HTML mail. Off blocks tracking pixels. */
  remoteImages: boolean;
  /** Start each visit with a random theme and pattern instead of the saved ones. */
  shuffle: boolean;
}

export const SETTINGS_KEY = 'vibemail.settings';
export const LOOK_KEY = 'vibemail.look';

export const DEFAULT_SETTINGS: Settings = {
  theme: 'hearthside',
  pattern: 'grain',
  motion: true,
  fontScale: 100,
  drift: true,
  driftSpeed: 2,
  driftDirection: 'se',
  driftSpin: 'cw',
  remoteImages: true,
  shuffle: true,
};

export const THEME_LABELS: Record<ThemeName, { name: string; blurb: string }> = {
  hearthside: { name: 'Hearthside', blurb: 'Cream parchment and amber lamplight' },
  moonlit: { name: 'Moonlit Window', blurb: 'Twilight blue menu windows' },
  meadow: { name: 'Meadow Paper', blurb: 'Soft green with a touch of rose' },
};

export const PATTERN_LABELS: Record<PatternName, string> = {
  grain: 'Paper grain',
  gingham: 'Gingham',
  clouds: 'Drifting clouds',
  stardust: 'Twinkling star-dust',
  none: 'Plain',
};

function oneOf<T extends string | number>(list: readonly T[], value: unknown, fallback: T): T {
  return list.find((item) => item === value) ?? fallback;
}

function speedOrDefault(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= DRIFT_SPEED_MIN && value <= DRIFT_SPEED_MAX
    ? value
    : DEFAULT_SETTINGS.driftSpeed;
}

/**
 * Parse stored settings, falling back to defaults field by field. Settings saved before the
 * random look existed have no `shuffle` field: that visitor already chose a look, so it stays.
 */
export function parseSettings(raw: string | null): Settings {
  if (!raw) return DEFAULT_SETTINGS;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return DEFAULT_SETTINGS;
    const p = parsed as Record<string, unknown>;
    // The "Stitched quilt" pattern became "Drifting clouds".
    const storedPattern = p.pattern === 'quilt' ? 'clouds' : p.pattern;
    return {
      theme: oneOf(THEMES, p.theme, DEFAULT_SETTINGS.theme),
      pattern: oneOf(PATTERNS, storedPattern, DEFAULT_SETTINGS.pattern),
      motion: typeof p.motion === 'boolean' ? p.motion : DEFAULT_SETTINGS.motion,
      fontScale: oneOf(FONT_SCALES, p.fontScale, DEFAULT_SETTINGS.fontScale),
      drift: typeof p.drift === 'boolean' ? p.drift : DEFAULT_SETTINGS.drift,
      driftSpeed: speedOrDefault(p.driftSpeed),
      driftDirection: oneOf(DRIFT_DIRECTIONS, p.driftDirection, DEFAULT_SETTINGS.driftDirection),
      driftSpin: oneOf(DRIFT_SPINS, p.driftSpin, DEFAULT_SETTINGS.driftSpin),
      remoteImages: typeof p.remoteImages === 'boolean' ? p.remoteImages : DEFAULT_SETTINGS.remoteImages,
      shuffle: typeof p.shuffle === 'boolean' ? p.shuffle : false,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function loadSettings(storage: Storage = window.localStorage): Settings {
  try {
    return parseSettings(storage.getItem(SETTINGS_KEY));
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(settings: Settings, storage: Storage = window.localStorage): void {
  try {
    storage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Preferences are a convenience; keep working without storage.
  }
}

// ---------------------------------------------------------------------------
// The look: the theme and pattern actually on screen
// ---------------------------------------------------------------------------

export interface Look {
  theme: ThemeName;
  pattern: PatternName;
  driftDirection: DriftDirection;
  driftSpeed: number;
  driftSpin: DriftSpin;
}

/** The settings that "Surprise me" chooses; picking any of them yourself ends the surprise. */
export const LOOK_FIELDS = ['theme', 'pattern', 'driftDirection', 'driftSpeed', 'driftSpin'] as const;

export function sameLook(a: Look, b: Look): boolean {
  return LOOK_FIELDS.every((field) => a[field] === b[field]);
}

/** A random theme, any pattern except Plain, and a gentle drift: any direction (or the circle) and speed. */
export function pickLook(random: () => number = Math.random): Look {
  const from = <T>(list: readonly T[], fallback: T): T => list[Math.floor(random() * list.length)] ?? fallback;
  return {
    theme: from(THEMES, DEFAULT_SETTINGS.theme),
    pattern: from(SHUFFLE_PATTERNS, 'gingham'),
    driftDirection: from(DRIFT_DIRECTIONS, DEFAULT_SETTINGS.driftDirection),
    driftSpeed: DRIFT_SPEED_MIN + Math.floor(random() * (SHUFFLE_SPEED_MAX - DRIFT_SPEED_MIN + 1)),
    driftSpin: from(DRIFT_SPINS, DEFAULT_SETTINGS.driftSpin),
  };
}

export function parseLook(raw: string | null): Look | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const p = parsed as Record<string, unknown>;
    const theme = THEMES.find((t) => t === p.theme);
    const pattern = PATTERNS.find((x) => x === p.pattern);
    const driftDirection = DRIFT_DIRECTIONS.find((d) => d === p.driftDirection);
    const driftSpin = DRIFT_SPINS.find((x) => x === p.driftSpin);
    const speed = p.driftSpeed;
    const validSpeed = typeof speed === 'number' && Number.isInteger(speed) && speed >= DRIFT_SPEED_MIN && speed <= DRIFT_SPEED_MAX;
    return theme && pattern && driftDirection && driftSpin && validSpeed ? { theme, pattern, driftDirection, driftSpeed: speed, driftSpin } : null;
  } catch {
    return null;
  }
}

/** The random look is kept for the life of the browser tab, so reloads do not reshuffle. */
export function loadLook(storage: Storage = window.sessionStorage): Look | null {
  try {
    return parseLook(storage.getItem(LOOK_KEY));
  } catch {
    return null;
  }
}

export function saveLook(look: Look, storage: Storage = window.sessionStorage): void {
  try {
    storage.setItem(LOOK_KEY, JSON.stringify(look));
  } catch {
    // Without storage the look lasts until the next reload.
  }
}

/** The saved look, or this visit's random one when shuffling. */
export function effectiveLook(settings: Settings, shuffled: Look | null): Look {
  if (settings.shuffle && shuffled) return shuffled;
  return {
    theme: settings.theme,
    pattern: settings.pattern,
    driftDirection: settings.driftDirection,
    driftSpeed: settings.driftSpeed,
    driftSpin: settings.driftSpin,
  };
}

/** Why drifting is not running, for the Settings explanation; null when it is allowed. */
export function driftBlocker(
  settings: Settings,
  reducedMotion: boolean,
  pattern: PatternName = settings.pattern,
): 'motion' | 'pattern' | null {
  if (reducedMotion || !settings.motion) return 'motion';
  if (pattern === 'none') return 'pattern';
  return null;
}

/** Apply settings to the document root as attributes and CSS custom properties. */
export function applySettings(
  settings: Settings,
  root: HTMLElement,
  reducedMotion: boolean,
  look: Look = effectiveLook(settings, null),
): void {
  root.dataset.theme = look.theme;
  root.dataset.pattern = look.pattern;
  root.dataset.motion = settings.motion && !reducedMotion ? 'on' : 'off';
  root.dataset.drift = settings.drift && driftBlocker(settings, reducedMotion, look.pattern) === null ? 'on' : 'off';
  root.style.setProperty('--font-scale', String(settings.fontScale / 100));
}

/**
 * Runs before first paint (inlined in the root layout) so the saved look, or this visit's random
 * one, never flashes the defaults. A test runs it against `applySettings` to keep them identical.
 */
export const NO_FLASH_SCRIPT = `(function(){try{var d=document.documentElement;var raw=localStorage.getItem('${SETTINGS_KEY}');var s=JSON.parse(raw||'{}')||{};var themes=${JSON.stringify(THEMES)};var patterns=${JSON.stringify(PATTERNS)};var pool=${JSON.stringify(SHUFFLE_PATTERNS)};var dirs=${JSON.stringify(DRIFT_DIRECTIONS)};var spins=${JSON.stringify(DRIFT_SPINS)};var scales=${JSON.stringify(FONT_SCALES)};var rm=window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches;var theme=themes.indexOf(s.theme)>-1?s.theme:'${DEFAULT_SETTINGS.theme}';var stored=s.pattern==='quilt'?'clouds':s.pattern;var pattern=patterns.indexOf(stored)>-1?stored:'${DEFAULT_SETTINGS.pattern}';var shuffle=typeof s.shuffle==='boolean'?s.shuffle:!raw;if(shuffle){var look=null;try{look=JSON.parse(sessionStorage.getItem('${LOOK_KEY}')||'null')}catch(e){}var ok=look&&themes.indexOf(look.theme)>-1&&patterns.indexOf(look.pattern)>-1&&dirs.indexOf(look.driftDirection)>-1&&spins.indexOf(look.driftSpin)>-1&&typeof look.driftSpeed==='number'&&look.driftSpeed%1===0&&look.driftSpeed>=${DRIFT_SPEED_MIN}&&look.driftSpeed<=${DRIFT_SPEED_MAX};if(!ok){var pick=function(list){return list[Math.floor(Math.random()*list.length)]};look={theme:pick(themes),pattern:pick(pool),driftDirection:pick(dirs),driftSpeed:${DRIFT_SPEED_MIN}+Math.floor(Math.random()*${SHUFFLE_SPEED_MAX - DRIFT_SPEED_MIN + 1}),driftSpin:pick(spins)};try{sessionStorage.setItem('${LOOK_KEY}',JSON.stringify(look))}catch(e){}}theme=look.theme;pattern=look.pattern;}var motion=s.motion!==false&&!rm;d.dataset.theme=theme;d.dataset.pattern=pattern;d.dataset.motion=motion?'on':'off';d.dataset.drift=(s.drift!==false&&motion&&pattern!=='none')?'on':'off';d.style.setProperty('--font-scale',String((scales.indexOf(s.fontScale)>-1?s.fontScale:${DEFAULT_SETTINGS.fontScale})/100));}catch(e){}})();`;
