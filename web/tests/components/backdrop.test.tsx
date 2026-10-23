import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Backdrop } from '@/components/Backdrop';
import { SettingsProvider } from '@/components/SettingsProvider';
import { DEFAULT_SETTINGS, SETTINGS_KEY, type Settings } from '@/lib/settings';

/** A controllable animation-frame clock. */
let frames: Map<number, FrameRequestCallback>;
let nextId: number;
let clock: number;

function installClock() {
  frames = new Map();
  nextId = 1;
  clock = 1000;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = nextId++;
    frames.set(id, callback);
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    frames.delete(id);
  });
}

/** Run `count` frames of 1/60 s. Returns how many callbacks were pending when it ended. */
function advance(count: number): number {
  for (let i = 0; i < count; i += 1) {
    const pending = Array.from(frames.entries());
    frames.clear();
    clock += 1000 / 60;
    for (const [, callback] of pending) callback(clock);
  }
  return frames.size;
}

function mount(settings: Partial<Settings> = {}, reducedMotion = false) {
  window.localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...DEFAULT_SETTINGS, shuffle: false, pattern: 'gingham', ...settings }));
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: reducedMotion && query.includes('reduced-motion'),
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia;
  return render(
    <SettingsProvider>
      <Backdrop />
    </SettingsProvider>,
  );
}

const layer = () => document.querySelector<HTMLElement>('.backdrop-layer');
const offset = () => {
  const found = /translate3d\(([-\d.e]+)px, ([-\d.e]+)px/.exec(layer()?.style.transform ?? '');
  return { x: Number(found?.[1] ?? NaN), y: Number(found?.[2] ?? NaN) };
};

beforeEach(installClock);
afterEach(() => vi.unstubAllGlobals());

describe('Backdrop', () => {
  it('renders the pattern layer with five groups of stars', () => {
    mount();
    expect(layer()).not.toBeNull();
    expect(document.querySelectorAll('.backdrop-layer .star')).toHaveLength(5);
    expect(document.querySelector('.backdrop')).toHaveAttribute('aria-hidden', 'true');
  });

  it('drifts down and to the right by default', () => {
    mount();
    act(() => void advance(240));
    const { x, y } = offset();
    expect(x).toBeGreaterThan(0);
    expect(y).toBeGreaterThan(0);
    expect(x).toBeCloseTo(y, 3);
  });

  it('wraps within one tile (gingham is 56 px)', () => {
    mount({ driftSpeed: 10 });
    act(() => void advance(60 * 30));
    const { x, y } = offset();
    expect(x).toBeGreaterThanOrEqual(0);
    expect(x).toBeLessThan(56);
    expect(y).toBeGreaterThanOrEqual(0);
    expect(y).toBeLessThan(56);
  });

  it('moves up and to the left when asked: the offset wraps to the far side of the tile', () => {
    mount({ driftDirection: 'nw', driftSpeed: 10 });
    act(() => void advance(60));
    const { x, y } = offset();
    expect(x).toBeGreaterThan(28); // wrapped around from just below 0
    expect(y).toBeGreaterThan(28);
  });

  it('does not run at all when drifting is off, and the layer stays put', () => {
    mount({ drift: false });
    act(() => void advance(120));
    expect(offset()).toEqual({ x: 0, y: 0 });
    expect(frames.size).toBe(0);
  });

  it('does not run under reduced motion', () => {
    mount({}, true);
    act(() => void advance(120));
    expect(offset()).toEqual({ x: 0, y: 0 });
    expect(frames.size).toBe(0);
  });

  it('does not run for the Plain pattern', () => {
    mount({ pattern: 'none' });
    act(() => void advance(120));
    expect(frames.size).toBe(0);
  });

  it('keeps its loop going only while something moves', () => {
    mount();
    expect(advance(10)).toBe(1); // one frame always pending while drifting
  });

  it('travels in a loop for the big circle', () => {
    mount({ driftDirection: 'circle', driftSpeed: 10, driftSpin: 'cw' });
    act(() => void advance(60 * 5));
    const early = offset();
    act(() => void advance(60 * 5));
    const later = offset();
    expect(Number.isFinite(early.x) && Number.isFinite(later.x)).toBe(true);
    expect(Math.hypot(later.x - early.x, later.y - early.y)).toBeGreaterThan(1);
  });
});
