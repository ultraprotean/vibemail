import { describe, expect, it } from 'vitest';
import {
  CIRCLE_RADIUS_PX,
  INITIAL_DRIFT,
  MAX_STEP_SECONDS,
  VELOCITY_EASE_SECONDS,
  driftTarget,
  isSettled,
  speedPxPerSecond,
  stepDrift,
  wrap,
  type DriftState,
  type DriftTarget,
} from '@/lib/drift';
import { DEFAULT_SETTINGS } from '@/lib/settings';

const TILE = 100;

/** Advance for `seconds` of 60 fps frames. */
function run(state: DriftState, target: DriftTarget, seconds: number, tile = TILE): DriftState {
  let current = state;
  const frames = Math.round(seconds * 60);
  for (let i = 0; i < frames; i += 1) current = stepDrift(current, target, 1 / 60, tile);
  return current;
}

const speedOf = (s: DriftState) => Math.hypot(s.vx, s.vy);

/** Distance between two wrapped offsets the short way round (the pattern repeats every tile). */
const wrappedDelta = (from: number, to: number, tile: number) => ((((to - from) % tile) + tile * 1.5) % tile) - tile / 2;

describe('driftTarget', () => {
  it('defaults to down and to the right at 8 px per second along the path', () => {
    const target = driftTarget(DEFAULT_SETTINGS, true);
    expect(target.kind).toBe('compass');
    if (target.kind !== 'compass') return;
    expect(target.vx).toBeGreaterThan(0);
    expect(target.vy).toBeGreaterThan(0);
    expect(target.vx).toBeCloseTo(target.vy, 6);
    expect(Math.hypot(target.vx, target.vy)).toBeCloseTo(8, 6);
  });

  it('travels at the same speed in every direction, diagonals included', () => {
    for (const direction of ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'] as const) {
      const target = driftTarget({ ...DEFAULT_SETTINGS, driftDirection: direction, driftSpeed: 5 }, true);
      if (target.kind !== 'compass') throw new Error('expected compass');
      expect(Math.hypot(target.vx, target.vy)).toBeCloseTo(20, 6);
    }
  });

  it('points each compass direction the right way on screen', () => {
    const v = (direction: 'n' | 'e' | 's' | 'w') => {
      const t = driftTarget({ ...DEFAULT_SETTINGS, driftDirection: direction }, true);
      if (t.kind !== 'compass') throw new Error('expected compass');
      return t;
    };
    expect(v('e').vx).toBeGreaterThan(0);
    expect(v('w').vx).toBeLessThan(0);
    expect(v('s').vy).toBeGreaterThan(0);
    expect(v('n').vy).toBeLessThan(0);
  });

  it('scales speed in 4 px per second steps', () => {
    expect(speedPxPerSecond(1)).toBe(4);
    expect(speedPxPerSecond(10)).toBe(40);
  });

  it('is a stop when drifting is not running', () => {
    expect(driftTarget(DEFAULT_SETTINGS, false)).toEqual({ kind: 'compass', vx: 0, vy: 0 });
  });

  it('describes the circle with its speed and spin', () => {
    expect(driftTarget({ ...DEFAULT_SETTINGS, driftDirection: 'circle', driftSpeed: 3, driftSpin: 'ccw' }, true)).toEqual({
      kind: 'circle',
      speed: 12,
      spin: 'ccw',
    });
  });
});

describe('wrap', () => {
  it('keeps offsets within one tile, in both directions', () => {
    expect(wrap(250, 100)).toBe(50);
    expect(wrap(-30, 100)).toBe(70);
    expect(wrap(0, 100)).toBe(0);
    expect(wrap(5, 0)).toBe(0);
  });
});

describe('stepDrift: smooth changes', () => {
  const east = driftTarget({ ...DEFAULT_SETTINGS, driftDirection: 'e', driftSpeed: 10 }, true);
  const west = driftTarget({ ...DEFAULT_SETTINGS, driftDirection: 'w', driftSpeed: 10 }, true);
  const slowEast = driftTarget({ ...DEFAULT_SETTINGS, driftDirection: 'e', driftSpeed: 1 }, true);

  it('eases up to speed instead of starting at full speed', () => {
    const first = stepDrift(INITIAL_DRIFT, east, 1 / 60, 1000);
    expect(first.vx).toBeGreaterThan(0);
    expect(first.vx).toBeLessThan(2); // far below the 40 px/s target on the first frame
    const later = run(INITIAL_DRIFT, east, VELOCITY_EASE_SECONDS * 6, 1000);
    expect(later.vx).toBeCloseTo(40, 0);
  });

  it('changing speed never jumps: the per-frame step stays small and continuous', () => {
    let state = run(INITIAL_DRIFT, east, 3, 100000);
    let previous = state.x;
    let biggestJump = 0;
    for (let i = 0; i < 120; i += 1) {
      state = stepDrift(state, slowEast, 1 / 60, 100000);
      biggestJump = Math.max(biggestJump, Math.abs(state.x - previous));
      previous = state.x;
    }
    // Full speed is 40 px/s (0.67 px per frame); a sudden change would be much larger than that.
    expect(biggestJump).toBeLessThan(0.7);
    expect(state.vx).toBeLessThan(40);
    expect(state.vx).toBeGreaterThan(4);
  });

  it('reversing direction slows through zero and turns around without a jump', () => {
    let state = run(INITIAL_DRIFT, east, 3, 100000);
    const speeds: number[] = [];
    let previousX = state.x;
    let biggestJump = 0;
    for (let i = 0; i < 240; i += 1) {
      state = stepDrift(state, west, 1 / 60, 100000);
      speeds.push(state.vx);
      biggestJump = Math.max(biggestJump, Math.abs(wrappedDelta(previousX, state.x, 100000)));
      previousX = state.x;
    }
    expect(biggestJump).toBeLessThan(0.7);
    expect(speeds[0]).toBeGreaterThan(0);
    expect(speeds[speeds.length - 1]).toBeLessThan(0);
    // The velocity falls steadily from +40 to -40 px/s: it never rises, and no frame changes it by
    // more than about 3% of the 80 px/s swing.
    for (let i = 1; i < speeds.length; i += 1) {
      const step = (speeds[i] ?? 0) - (speeds[i - 1] ?? 0);
      expect(step).toBeLessThanOrEqual(0);
      expect(Math.abs(step)).toBeLessThan(2.5);
    }
  });

  it('stops gently and then reports settled so the loop can pause', () => {
    const stop = driftTarget(DEFAULT_SETTINGS, false);
    let state = run(INITIAL_DRIFT, east, 3, 100000);
    expect(isSettled(state, stop)).toBe(false);
    state = run(state, stop, 8, 100000);
    expect(isSettled(state, stop)).toBe(true);
    expect(isSettled(state, east)).toBe(false);
  });

  it('limits a long gap (a tab waking up) to one short step', () => {
    const jumped = stepDrift(run(INITIAL_DRIFT, east, 3, 100000), east, 30, 100000);
    const normal = stepDrift(run(INITIAL_DRIFT, east, 3, 100000), east, MAX_STEP_SECONDS, 100000);
    expect(jumped.x).toBeCloseTo(normal.x, 6);
    expect(stepDrift(INITIAL_DRIFT, east, -5, 100)).toEqual(stepDrift(INITIAL_DRIFT, east, 0, 100));
  });

  it('wraps the offset by one tile, so it never grows without bound', () => {
    const state = run(INITIAL_DRIFT, east, 60, TILE);
    expect(state.x).toBeGreaterThanOrEqual(0);
    expect(state.x).toBeLessThan(TILE);
    expect(state.y).toBeGreaterThanOrEqual(0);
    expect(state.y).toBeLessThan(TILE);
  });

  it('does not move when there is no tile (Plain pattern)', () => {
    const state = run(INITIAL_DRIFT, east, 2, 0);
    expect(state.x).toBe(0);
    expect(state.y).toBe(0);
  });
});

describe('stepDrift: the big circle', () => {
  const circle = (spin: 'cw' | 'ccw', level = 10) => driftTarget({ ...DEFAULT_SETTINGS, driftDirection: 'circle', driftSpeed: level, driftSpin: spin }, true);

  it('turns the heading steadily at speed divided by radius', () => {
    const target = circle('cw', 10);
    if (target.kind !== 'circle') throw new Error('expected circle');
    const warmed = run(INITIAL_DRIFT, target, 5, 1e6);
    const later = run(warmed, target, 10, 1e6);
    const turned = later.angle - warmed.angle;
    expect(turned).toBeCloseTo((target.speed / CIRCLE_RADIUS_PX) * 10, 2);
  });

  it('turns clockwise one way and counterclockwise the other, in screen terms', () => {
    const cw = run(INITIAL_DRIFT, circle('cw'), 10, 1e6);
    const ccw = run(INITIAL_DRIFT, circle('ccw'), 10, 1e6);
    // Starting heading is down-right (45 degrees); clockwise on screen increases the angle.
    expect(cw.angle).toBeGreaterThan(Math.PI / 4);
    expect(ccw.angle).toBeLessThan(Math.PI / 4);
  });

  it('keeps its speed while it circles, and comes back round to the same direction', () => {
    const target = circle('cw', 10);
    if (target.kind !== 'circle') throw new Error('expected circle');
    let state = run(INITIAL_DRIFT, target, 4, 1e6);
    expect(speedOf(state)).toBeGreaterThan(30);
    const period = (2 * Math.PI * CIRCLE_RADIUS_PX) / target.speed; // 78.5 s at 40 px/s
    const startAngle = state.angle;
    state = run(state, target, period, 1e6);
    const difference = Math.abs(((state.angle - startAngle + Math.PI) % (2 * Math.PI)) - Math.PI);
    expect(difference).toBeLessThan(0.05);
    expect(speedOf(state)).toBeGreaterThan(30);
  });

  it('actually travels in a loop: the path returns near where it started', () => {
    const target = circle('cw', 10);
    if (target.kind !== 'circle') throw new Error('expected circle');
    let state = run(INITIAL_DRIFT, target, 5, 1e9);
    const start = { x: state.x, y: state.y };
    const period = (2 * Math.PI * CIRCLE_RADIUS_PX) / target.speed;
    state = run(state, target, period, 1e9);
    expect(Math.hypot(state.x - start.x, state.y - start.y)).toBeLessThan(CIRCLE_RADIUS_PX * 0.15);
  });

  it('joins the circle heading the way it was already going, with no turn or jump', () => {
    const south = driftTarget({ ...DEFAULT_SETTINGS, driftDirection: 's', driftSpeed: 10 }, true);
    let state = run(INITIAL_DRIFT, south, 3, 1e6);
    expect(state.vy).toBeGreaterThan(30);
    const before = { vx: state.vx, vy: state.vy };
    state = stepDrift(state, circle('cw'), 1 / 60, 1e6);
    expect(state.mode).toBe('circle');
    expect(state.angle).toBeCloseTo(Math.PI / 2, 1); // heading south
    expect(Math.abs(state.vx - before.vx)).toBeLessThan(0.5);
    expect(Math.abs(state.vy - before.vy)).toBeLessThan(0.5);
  });

  it('leaves the circle smoothly for a compass direction', () => {
    let state = run(INITIAL_DRIFT, circle('cw'), 5, 1e6);
    expect(state.mode).toBe('circle');
    const east = driftTarget({ ...DEFAULT_SETTINGS, driftDirection: 'e', driftSpeed: 10 }, true);
    const next = stepDrift(state, east, 1 / 60, 1e6);
    expect(next.mode).toBe('compass');
    expect(Math.abs(next.vx - state.vx)).toBeLessThan(2);
    state = run(next, east, 5, 1e6);
    expect(state.vx).toBeCloseTo(40, 0);
    expect(Math.abs(state.vy)).toBeLessThan(0.5);
  });
});
