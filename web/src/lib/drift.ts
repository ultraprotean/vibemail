import { DRIFT_PX_PER_SECOND_PER_LEVEL, DRIFT_VECTORS, type DriftSpin, type Settings } from './settings';

/**
 * The background drift engine. It is a small physics loop rather than a CSS animation because a
 * CSS animation jumps when its duration or direction changes. Here the velocity eases toward its
 * target, so changing the speed or direction (or switching to the circle) glides.
 */

/** Radius of the big circle the pattern travels along, in pixels. */
export const CIRCLE_RADIUS_PX = 500;
/** Time constant of the velocity easing: about 63% of a change lands in this many seconds. */
export const VELOCITY_EASE_SECONDS = 0.6;
/** Longest step the loop integrates, so a tab that wakes up after a pause does not leap. */
export const MAX_STEP_SECONDS = 0.1;
/** Below this speed (pixels per second) a stopping drift counts as stopped. */
const SETTLED_SPEED = 0.05;

export type DriftMode = 'compass' | 'circle';

export interface DriftState {
  /** Offset of the pattern layer in pixels, kept within one tile. */
  x: number;
  y: number;
  /** Current velocity in pixels per second. */
  vx: number;
  vy: number;
  /** Heading in radians while travelling in the circle (0 = right, increasing = clockwise on screen). */
  angle: number;
  mode: DriftMode;
}

export const INITIAL_DRIFT: DriftState = { x: 0, y: 0, vx: 0, vy: 0, angle: Math.PI / 4, mode: 'compass' };

export type DriftTarget =
  | { kind: 'compass'; vx: number; vy: number }
  | { kind: 'circle'; speed: number; spin: DriftSpin };

export function speedPxPerSecond(level: number): number {
  return level * DRIFT_PX_PER_SECOND_PER_LEVEL;
}

/** Where the velocity is heading: the chosen direction at the chosen speed, or a stop. */
export function driftTarget(settings: Pick<Settings, 'driftDirection' | 'driftSpeed' | 'driftSpin'>, running: boolean): DriftTarget {
  if (!running) return { kind: 'compass', vx: 0, vy: 0 };
  const speed = speedPxPerSecond(settings.driftSpeed);
  if (settings.driftDirection === 'circle') return { kind: 'circle', speed, spin: settings.driftSpin };
  const { dx, dy } = DRIFT_VECTORS[settings.driftDirection];
  const length = Math.hypot(dx, dy);
  // Diagonals are normalized so every direction travels at the same speed along its path.
  return { kind: 'compass', vx: (speed * dx) / length, vy: (speed * dy) / length };
}

/** Wrap into [0, tile) so the offset never grows; the pattern repeats every tile. */
export function wrap(value: number, tile: number): number {
  if (tile <= 0) return 0;
  return ((value % tile) + tile) % tile;
}

/** Advance the drift by `dtSeconds`. Pure: returns a new state. */
export function stepDrift(state: DriftState, target: DriftTarget, dtSeconds: number, tile: number): DriftState {
  const dt = Math.min(Math.max(dtSeconds, 0), MAX_STEP_SECONDS);
  let angle = state.angle;
  let mode: DriftMode = state.mode;
  let targetVx: number;
  let targetVy: number;

  if (target.kind === 'circle') {
    if (mode !== 'circle') {
      // Join the circle already heading the way we are going, so there is no sudden turn.
      if (Math.hypot(state.vx, state.vy) > SETTLED_SPEED) angle = Math.atan2(state.vy, state.vx);
      mode = 'circle';
    }
    const turn = (target.spin === 'cw' ? 1 : -1) * (target.speed / CIRCLE_RADIUS_PX) * dt;
    angle = (angle + turn) % (Math.PI * 2);
    targetVx = target.speed * Math.cos(angle);
    targetVy = target.speed * Math.sin(angle);
  } else {
    mode = 'compass';
    targetVx = target.vx;
    targetVy = target.vy;
  }

  const ease = 1 - Math.exp(-dt / VELOCITY_EASE_SECONDS);
  const vx = state.vx + (targetVx - state.vx) * ease;
  const vy = state.vy + (targetVy - state.vy) * ease;
  return { x: wrap(state.x + vx * dt, tile), y: wrap(state.y + vy * dt, tile), vx, vy, angle, mode };
}

/** True once a drift that is being stopped has come to rest, so the loop can pause. */
export function isSettled(state: DriftState, target: DriftTarget): boolean {
  return target.kind === 'compass' && target.vx === 0 && target.vy === 0 && Math.hypot(state.vx, state.vy) < SETTLED_SPEED;
}
