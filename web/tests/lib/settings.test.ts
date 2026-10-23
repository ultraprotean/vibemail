import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  COMPASS_DIRECTIONS,
  DEFAULT_SETTINGS,
  DRIFT_DIRECTIONS,
  DRIFT_VECTORS,
  LOOK_KEY,
  NO_FLASH_SCRIPT,
  PATTERNS,
  PATTERN_TILES,
  SHUFFLE_PATTERNS,
  THEMES,
  applySettings,
  driftBlocker,
  effectiveLook,
  loadLook,
  loadSettings,
  parseLook,
  parseSettings,
  pickLook,
  saveLook,
  saveSettings,
  type Look,
  type Settings,
  LOOK_FIELDS,
  SHUFFLE_SPEED_MAX,
  DRIFT_SPEED_MIN,
  DRIFT_SPINS,
  sameLook,
} from '@/lib/settings';
import { lookJson, makeLook } from '../helpers/look';

describe('settings storage', () => {
  it('falls back to defaults for missing or invalid values', () => {
    expect(parseSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings('garbage')).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings('42')).toEqual(DEFAULT_SETTINGS);
  });

  it('keeps valid fields and defaults the rest', () => {
    const parsed = parseSettings(JSON.stringify({ theme: 'neon', pattern: 'zigzag', fontScale: 300, motion: 'yes', shuffle: true }));
    expect(parsed).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings(JSON.stringify({ theme: 'moonlit', fontScale: 110, shuffle: true }))).toEqual({
      ...DEFAULT_SETTINGS,
      theme: 'moonlit',
      fontScale: 110,
    });
  });

  it('persists and restores every preference', () => {
    const next: Settings = {
      theme: 'meadow',
      pattern: 'clouds',
      motion: false,
      fontScale: 90,
      drift: false,
      driftSpeed: 7,
      driftDirection: 'circle',
      driftSpin: 'ccw',
      remoteImages: false,
      shuffle: false,
    };
    saveSettings(next);
    expect(loadSettings()).toEqual(next);
  });

  it('turns the random look off for settings saved before it existed', () => {
    const parsed = parseSettings(JSON.stringify({ theme: 'meadow', pattern: 'gingham' }));
    expect(parsed.shuffle).toBe(false);
    expect(parsed).toMatchObject({ theme: 'meadow', pattern: 'gingham' });
  });

  it('starts first-time visitors with the random look on', () => {
    expect(DEFAULT_SETTINGS.shuffle).toBe(true);
    expect(parseSettings(null).shuffle).toBe(true);
  });

  it('migrates the old Stitched quilt pattern to Drifting clouds', () => {
    expect(parseSettings(JSON.stringify({ pattern: 'quilt', shuffle: false })).pattern).toBe('clouds');
  });
});

describe('background drift settings', () => {
  it('defaults to drifting slowly down and to the right', () => {
    expect(DEFAULT_SETTINGS).toMatchObject({ drift: true, driftDirection: 'se', driftSpeed: 2, driftSpin: 'cw' });
    expect(DRIFT_VECTORS[DEFAULT_SETTINGS.driftDirection as keyof typeof DRIFT_VECTORS]).toEqual({ dx: 1, dy: 1 });
    // Settings saved before drift existed pick the drift defaults up.
    expect(parseSettings(JSON.stringify({ theme: 'meadow' }))).toMatchObject({ drift: true, driftDirection: 'se', driftSpeed: 2, driftSpin: 'cw' });
  });

  it('offers the eight compass directions and a big circle', () => {
    expect([...DRIFT_DIRECTIONS].sort()).toEqual([...COMPASS_DIRECTIONS, 'circle'].sort());
    expect(DRIFT_DIRECTIONS).toHaveLength(9);
  });

  it('rejects invalid drift values field by field', () => {
    expect(parseSettings(JSON.stringify({ drift: 'yes', driftSpeed: 11, driftDirection: 'up', driftSpin: 'sideways', shuffle: true }))).toMatchObject({
      drift: true,
      driftSpeed: 2,
      driftDirection: 'se',
      driftSpin: 'cw',
    });
    expect(parseSettings(JSON.stringify({ driftSpeed: 2.5 })).driftSpeed).toBe(2);
    expect(parseSettings(JSON.stringify({ driftSpeed: 0 })).driftSpeed).toBe(2);
    expect(parseSettings(JSON.stringify({ driftSpeed: 10, driftDirection: 'circle', driftSpin: 'ccw', drift: false }))).toMatchObject({
      drift: false,
      driftSpeed: 10,
      driftDirection: 'circle',
      driftSpin: 'ccw',
    });
  });

  it('is on by default, and off when drift is off, motion is off or reduced, or the pattern is Plain', () => {
    const driftAttribute = (settings: Settings, reduced = false, look?: Look) => {
      const root = document.createElement('html');
      applySettings(settings, root, reduced, look);
      return root.dataset.drift;
    };
    expect(driftAttribute(DEFAULT_SETTINGS)).toBe('on');
    expect(driftAttribute({ ...DEFAULT_SETTINGS, drift: false })).toBe('off');
    expect(driftAttribute({ ...DEFAULT_SETTINGS, motion: false })).toBe('off');
    expect(driftAttribute(DEFAULT_SETTINGS, true)).toBe('off');
    expect(driftAttribute({ ...DEFAULT_SETTINGS, pattern: 'none' })).toBe('off');
    expect(driftAttribute(DEFAULT_SETTINGS, false, makeLook('meadow', 'none'))).toBe('off');
  });

  it('reports why drifting is blocked, judging the pattern actually on screen', () => {
    expect(driftBlocker(DEFAULT_SETTINGS, false)).toBeNull();
    expect(driftBlocker({ ...DEFAULT_SETTINGS, motion: false }, false)).toBe('motion');
    expect(driftBlocker(DEFAULT_SETTINGS, true)).toBe('motion');
    expect(driftBlocker({ ...DEFAULT_SETTINGS, pattern: 'none' }, false)).toBe('pattern');
    expect(driftBlocker({ ...DEFAULT_SETTINGS, pattern: 'none' }, false, 'gingham')).toBeNull();
  });
});

describe('applySettings', () => {
  it('applies the look and font scale to the root', () => {
    const root = document.createElement('html');
    applySettings({ ...DEFAULT_SETTINGS, fontScale: 110 }, root, false, makeLook('moonlit', 'stardust'));
    expect(root.dataset.theme).toBe('moonlit');
    expect(root.dataset.pattern).toBe('stardust');
    expect(root.dataset.motion).toBe('on');
    expect(root.style.getPropertyValue('--font-scale')).toBe('1.1');
  });

  it('uses the saved theme and pattern when no random look is given', () => {
    const root = document.createElement('html');
    applySettings({ ...DEFAULT_SETTINGS, theme: 'meadow', pattern: 'gingham', shuffle: false }, root, false);
    expect(root.dataset.theme).toBe('meadow');
    expect(root.dataset.pattern).toBe('gingham');
  });

  it('forces motion off under reduced motion', () => {
    const root = document.createElement('html');
    applySettings({ ...DEFAULT_SETTINGS, motion: true }, root, true);
    expect(root.dataset.motion).toBe('off');
  });
});

describe('random look', () => {
  it('picks a theme, any pattern except Plain, and a drift', () => {
    for (let i = 0; i < 300; i += 1) {
      const look = pickLook();
      expect(THEMES).toContain(look.theme);
      expect(SHUFFLE_PATTERNS).toContain(look.pattern);
      expect(DRIFT_DIRECTIONS).toContain(look.driftDirection);
      expect(DRIFT_SPINS).toContain(look.driftSpin);
      expect(Number.isInteger(look.driftSpeed)).toBe(true);
      expect(look.driftSpeed).toBeGreaterThanOrEqual(DRIFT_SPEED_MIN);
      expect(look.driftSpeed).toBeLessThanOrEqual(SHUFFLE_SPEED_MAX);
    }
    expect(SHUFFLE_PATTERNS).not.toContain('none');
    expect([...SHUFFLE_PATTERNS].sort()).toEqual(PATTERNS.filter((pattern) => pattern !== 'none').sort());
  });

  it('keeps random drift speeds to the gentle half of the range', () => {
    expect(SHUFFLE_SPEED_MAX).toBeLessThan(10);
    const speeds = new Set<number>();
    for (let i = 0; i < 600; i += 1) speeds.add(pickLook().driftSpeed);
    expect([...speeds].sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it('can reach every theme, pattern, direction (circle included) and spin', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1500; i += 1) {
      const { theme, pattern, driftDirection, driftSpin } = pickLook();
      seen.add(theme);
      seen.add(pattern);
      seen.add(driftDirection);
      seen.add(driftSpin);
    }
    for (const name of [...THEMES, ...SHUFFLE_PATTERNS, ...DRIFT_DIRECTIONS, ...DRIFT_SPINS]) expect(seen).toContain(name);
  });

  it('is deterministic given a random source', () => {
    expect(pickLook(() => 0)).toEqual({
      theme: THEMES[0],
      pattern: SHUFFLE_PATTERNS[0],
      driftDirection: DRIFT_DIRECTIONS[0],
      driftSpeed: 1,
      driftSpin: DRIFT_SPINS[0],
    });
    expect(pickLook(() => 0.999)).toEqual({
      theme: THEMES[THEMES.length - 1],
      pattern: SHUFFLE_PATTERNS[SHUFFLE_PATTERNS.length - 1],
      driftDirection: DRIFT_DIRECTIONS[DRIFT_DIRECTIONS.length - 1],
      driftSpeed: SHUFFLE_SPEED_MAX,
      driftSpin: DRIFT_SPINS[DRIFT_SPINS.length - 1],
    });
  });

  it('is made of exactly the fields Surprise me controls', () => {
    expect(Object.keys(pickLook()).sort()).toEqual([...LOOK_FIELDS].sort());
  });

  it('compares looks field by field', () => {
    expect(sameLook(makeLook('meadow', 'clouds'), makeLook('meadow', 'clouds'))).toBe(true);
    expect(sameLook(makeLook('meadow', 'clouds'), makeLook('meadow', 'clouds', { driftSpeed: 3 }))).toBe(false);
    expect(sameLook(makeLook('meadow', 'clouds'), makeLook('meadow', 'clouds', { driftDirection: 'circle' }))).toBe(false);
  });

  it('is remembered for the tab and ignores anything incomplete or invalid', () => {
    expect(loadLook()).toBeNull();
    const full = makeLook('meadow', 'clouds', { driftDirection: 'circle', driftSpeed: 4, driftSpin: 'ccw' });
    saveLook(full);
    expect(loadLook()).toEqual(full);
    expect(parseLook('{"theme":"meadow","pattern":"clouds"}')).toBeNull(); // saved before drift was part of it
    expect(parseLook(lookJson('meadow', 'clouds', { driftSpeed: 11 }))).toBeNull();
    expect(parseLook(lookJson('meadow', 'clouds', { driftSpeed: 2.5 }))).toBeNull();
    expect(parseLook(lookJson('meadow', 'clouds', { driftDirection: 'up' as never }))).toBeNull();
    expect(parseLook(lookJson('meadow', 'clouds', { driftSpin: 'sideways' as never }))).toBeNull();
    expect(parseLook(lookJson('neon' as never, 'clouds'))).toBeNull();
    expect(parseLook(lookJson('meadow', 'zigzag' as never))).toBeNull();
    expect(parseLook('nope')).toBeNull();
    expect(parseLook(null)).toBeNull();
  });

  it('shows the random look, drift included, only while shuffling', () => {
    const shuffled: Look = makeLook('moonlit', 'stardust', { driftDirection: 'nw', driftSpeed: 4, driftSpin: 'ccw' });
    expect(effectiveLook({ ...DEFAULT_SETTINGS, shuffle: true }, shuffled)).toEqual(shuffled);
    expect(
      effectiveLook({ ...DEFAULT_SETTINGS, shuffle: false, theme: 'meadow', pattern: 'gingham', driftDirection: 'e', driftSpeed: 7, driftSpin: 'cw' }, shuffled),
    ).toEqual(makeLook('meadow', 'gingham', { driftDirection: 'e', driftSpeed: 7 }));
    expect(effectiveLook({ ...DEFAULT_SETTINGS, shuffle: true }, null)).toEqual(makeLook('hearthside', 'grain'));
  });
});

describe('pre-paint script', () => {
  const root = () => document.documentElement;
  const run = () => {
    root().removeAttribute('style');
    window.eval(NO_FLASH_SCRIPT);
  };

  it('applies a saved look exactly as applySettings does', () => {
    const variants: Partial<Settings>[] = [
      { shuffle: false },
      { shuffle: false, theme: 'moonlit', pattern: 'stardust', driftDirection: 'nw', driftSpeed: 9 },
      { shuffle: false, pattern: 'none' },
      { shuffle: false, motion: false, driftDirection: 'circle' },
      { shuffle: false, drift: false, fontScale: 110, theme: 'meadow', pattern: 'clouds' },
    ];
    for (const variant of variants) {
      const settings = { ...DEFAULT_SETTINGS, ...variant };
      window.localStorage.setItem('vibemail.settings', JSON.stringify(settings));
      run();
      const expected = document.createElement('html');
      applySettings(settings, expected, false);
      for (const attribute of ['theme', 'pattern', 'motion', 'drift'] as const) {
        expect(root().dataset[attribute]).toBe(expected.dataset[attribute]);
      }
      expect(root().style.getPropertyValue('--font-scale')).toBe(expected.style.getPropertyValue('--font-scale'));
    }
  });

  it('picks and remembers a random look for first-time visitors, matching what the app will show', () => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    run();
    const remembered = parseLook(window.sessionStorage.getItem(LOOK_KEY));
    expect(remembered).not.toBeNull();
    expect(SHUFFLE_PATTERNS).toContain(remembered?.pattern);
    expect(DRIFT_DIRECTIONS).toContain(remembered?.driftDirection);
    expect(DRIFT_SPINS).toContain(remembered?.driftSpin);
    expect(remembered?.driftSpeed).toBeGreaterThanOrEqual(DRIFT_SPEED_MIN);
    expect(remembered?.driftSpeed).toBeLessThanOrEqual(SHUFFLE_SPEED_MAX);
    expect(root().dataset.theme).toBe(remembered?.theme);
    expect(root().dataset.pattern).toBe(remembered?.pattern);
    expect(root().dataset.drift).toBe('on');

    const applied = document.createElement('html');
    applySettings(DEFAULT_SETTINGS, applied, false, effectiveLook(DEFAULT_SETTINGS, loadLook()));
    expect(applied.dataset.theme).toBe(root().dataset.theme);
    expect(applied.dataset.pattern).toBe(root().dataset.pattern);
  });

  it('reuses the tab\'s look on reload instead of reshuffling', () => {
    window.localStorage.clear();
    window.sessionStorage.setItem(LOOK_KEY, lookJson('meadow', 'clouds', { driftDirection: 'ne', driftSpeed: 3 }));
    for (let i = 0; i < 5; i += 1) {
      run();
      expect(root().dataset.theme).toBe('meadow');
      expect(root().dataset.pattern).toBe('clouds');
    }
  });

  it('does not shuffle for visitors who already chose a look', () => {
    window.sessionStorage.clear();
    window.localStorage.setItem('vibemail.settings', JSON.stringify({ theme: 'meadow', pattern: 'gingham' }));
    run();
    expect(root().dataset.theme).toBe('meadow');
    expect(root().dataset.pattern).toBe('gingham');
    expect(window.sessionStorage.getItem(LOOK_KEY)).toBeNull();
  });

  it('replaces a remembered look that predates the drift with a complete one, as the app would', () => {
    window.localStorage.clear();
    window.sessionStorage.setItem(LOOK_KEY, JSON.stringify({ theme: 'meadow', pattern: 'clouds' }));
    run();
    const remembered = parseLook(window.sessionStorage.getItem(LOOK_KEY));
    expect(remembered).not.toBeNull();
    expect(root().dataset.theme).toBe(remembered?.theme);
    expect(root().dataset.pattern).toBe(remembered?.pattern);
  });

  it('migrates the old quilt pattern', () => {
    window.localStorage.setItem('vibemail.settings', JSON.stringify({ pattern: 'quilt', shuffle: false }));
    run();
    expect(root().dataset.pattern).toBe('clouds');
  });
});

describe('pattern tiles', () => {
  const css = readFileSync(join(__dirname, '../../src/styles/patterns.css'), 'utf8');

  it('match the --tile sizes in patterns.css, so the drift loop is seamless', () => {
    for (const pattern of PATTERNS) {
      const found = new RegExp(`html\\[data-pattern='${pattern}'\\]\\s*\\{\\s*--tile:\\s*(\\d+);`).exec(css);
      expect(found, `--tile for ${pattern}`).not.toBeNull();
      expect(Number(found?.[1])).toBe(PATTERN_TILES[pattern]);
    }
  });

  it('use the same tile for the mask or background repeat of each pattern', () => {
    expect(css).toContain('360px 360px repeat'); // clouds mask
    expect(css).toMatch(/background-size: 240px 240px/); // grain
    expect(css).toMatch(/background-size: 56px 56px/); // gingham
    expect(css).toMatch(/background-size: 320px 320px/); // stars
  });
});
