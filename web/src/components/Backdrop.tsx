'use client';

import { useEffect, useMemo, useRef } from 'react';
import { INITIAL_DRIFT, driftTarget, isSettled, stepDrift, type DriftState } from '@/lib/drift';
import { PATTERN_TILES, driftBlocker } from '@/lib/settings';
import { useSettings } from './SettingsProvider';

/** Twinkling stars come in groups that wink on different beats, so they never pulse in unison. */
const STAR_GROUPS = [1, 2, 3, 4, 5] as const;

/**
 * The fixed layer behind the app: the pattern, and the drift that slides it. The layer is one tile
 * larger than the screen on every side and its offset wraps by exactly one tile, so the loop is
 * seamless. The loop runs only while something is moving.
 */
export function Backdrop() {
  const { settings, look, reducedMotion } = useSettings();
  const layerRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef<DriftState>(INITIAL_DRIFT);

  const running = settings.drift && driftBlocker(settings, reducedMotion, look.pattern) === null;
  const { driftDirection, driftSpeed, driftSpin } = look;
  const target = useMemo(
    () => driftTarget({ driftDirection, driftSpeed, driftSpin }, running),
    [driftDirection, driftSpeed, driftSpin, running],
  );
  const tile = PATTERN_TILES[look.pattern];

  useEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    let frame = 0;
    let last: number | null = null;

    const tick = (now: number) => {
      const dt = last === null ? 0 : (now - last) / 1000;
      last = now;
      stateRef.current = stepDrift(stateRef.current, target, dt, tile);
      layer.style.transform = `translate3d(${stateRef.current.x}px, ${stateRef.current.y}px, 0)`;
      if (isSettled(stateRef.current, target)) {
        frame = 0;
        return;
      }
      frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => {
      if (frame) cancelAnimationFrame(frame);
    };
  }, [target, tile]);

  return (
    <div className="backdrop" aria-hidden="true">
      <div ref={layerRef} className="backdrop-layer">
        {STAR_GROUPS.map((group) => (
          <span key={group} className={`star star-${group}`} />
        ))}
      </div>
    </div>
  );
}
