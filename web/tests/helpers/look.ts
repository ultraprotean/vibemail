import type { Look, PatternName, ThemeName } from '@/lib/settings';

/** A complete look for tests: the given theme and pattern, with the default slow down-and-right drift unless overridden. */
export function makeLook(theme: ThemeName, pattern: PatternName, extra: Partial<Look> = {}): Look {
  return { theme, pattern, driftDirection: 'se', driftSpeed: 2, driftSpin: 'cw', ...extra };
}

export function lookJson(theme: ThemeName, pattern: PatternName, extra: Partial<Look> = {}): string {
  return JSON.stringify(makeLook(theme, pattern, extra));
}
