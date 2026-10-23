'use client';

import { useRef } from 'react';
import {
  COMPASS_DIRECTIONS,
  DRIFT_LABELS,
  DRIFT_SPEED_MAX,
  DRIFT_SPEED_MIN,
  DRIFT_SPINS,
  FONT_SCALES,
  PATTERNS,
  PATTERN_LABELS,
  THEMES,
  THEME_LABELS,
  driftBlocker,
  type DriftDirection,
  type DriftSpin,
  type FontScale,
  type PatternName,
  type ThemeName,
} from '@/lib/settings';
import { useFocusTrap } from '@/lib/useFocusTrap';
import { useAuth } from './AuthProvider';
import { useSettings } from './SettingsProvider';

/** Rotation of a right-pointing arrow for each direction the background can move. */
const ARROW_DEGREES: Record<(typeof COMPASS_DIRECTIONS)[number], number> = { e: 0, se: 45, s: 90, sw: 135, w: 180, nw: 225, n: 270, ne: 315 };

const SPIN_LABELS: Record<DriftSpin, string> = { cw: 'Clockwise', ccw: 'Counterclockwise' };

function speedWord(level: number): string {
  if (level <= 3) return 'Slow';
  if (level <= 7) return 'Medium';
  return 'Fast';
}

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const { settings, look, update, reshuffle, reducedMotion } = useSettings();
  const { signOut, mock } = useAuth();
  const panelRef = useRef<HTMLDivElement>(null);
  useFocusTrap(panelRef, true, onClose);
  const motionOn = settings.motion && !reducedMotion;
  const blocker = driftBlocker(settings, reducedMotion, look.pattern);
  const driftRunning = blocker === null && settings.drift;
  const driftControlsDisabled = blocker !== null;
  const padCells: DriftDirection[] = [...COMPASS_DIRECTIONS.slice(0, 4), 'circle', ...COMPASS_DIRECTIONS.slice(4)];

  return (
    <div className="dialog-layer">
      <div className="dialog-scrim" onClick={onClose} aria-hidden="true" />
      <div ref={panelRef} className="dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <header className="dialog-header">
          <h2 id="settings-title">Settings</h2>
          <button type="button" className="icon-button" aria-label="Close settings" onClick={onClose}>
            ×
          </button>
        </header>

        <div className="dialog-body">
          <div className="setting setting-row">
            <div>
              <label htmlFor="shuffle-toggle" className="setting-label">
                Surprise me
              </label>
              <p className="setting-note">A new theme, pattern and drift each time you open VibeMail. Picking your own turns this off.</p>
              {settings.shuffle && (
                <button type="button" className="link-button" onClick={reshuffle}>
                  Shuffle now
                </button>
              )}
            </div>
            <button
              id="shuffle-toggle"
              type="button"
              role="switch"
              aria-checked={settings.shuffle}
              className="switch"
              onClick={() => update({ shuffle: !settings.shuffle })}
            >
              <span className="switch-knob" />
              <span className="visually-hidden">{settings.shuffle ? 'On' : 'Off'}</span>
            </button>
          </div>

          <fieldset className="setting">
            <legend>Theme</legend>
            <div className="theme-options">
              {THEMES.map((theme: ThemeName) => (
                <label key={theme} className="theme-option" data-theme-preview={theme} data-selected={look.theme === theme}>
                  <input type="radio" name="theme" value={theme} checked={look.theme === theme} onChange={() => update({ theme })} />
                  <span className="theme-swatch" aria-hidden="true" />
                  <span className="theme-name">{THEME_LABELS[theme].name}</span>
                  <span className="theme-blurb">{THEME_LABELS[theme].blurb}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <div className="setting">
            <label htmlFor="pattern-select" className="setting-label">
              Background pattern
            </label>
            <select id="pattern-select" value={look.pattern} onChange={(e) => update({ pattern: e.target.value as PatternName })}>
              {PATTERNS.map((pattern) => (
                <option key={pattern} value={pattern}>
                  {PATTERN_LABELS[pattern]}
                </option>
              ))}
            </select>
          </div>

          <fieldset className="setting drift" data-disabled={driftControlsDisabled}>
            <legend>Background drift</legend>
            <div className="setting-row">
              <div>
                <label htmlFor="drift-toggle" className="setting-label">
                  Let the background drift
                </label>
                {blocker === 'motion' && (
                  <p className="setting-note">
                    {reducedMotion ? 'Off because your device asks for reduced motion.' : 'Turn on gentle animation to let it drift.'}
                  </p>
                )}
                {blocker === 'pattern' && <p className="setting-note">Pick a pattern above to give it something to drift.</p>}
              </div>
              <button
                id="drift-toggle"
                type="button"
                role="switch"
                aria-checked={driftRunning}
                className="switch"
                disabled={driftControlsDisabled}
                onClick={() => update({ drift: !settings.drift })}
              >
                <span className="switch-knob" />
                <span className="visually-hidden">{driftRunning ? 'On' : 'Off'}</span>
              </button>
            </div>

            <div className="drift-direction" role="radiogroup" aria-label="Drift direction">
              <p className="setting-label">Direction</p>
              <div className="drift-pad">
                {padCells.map((direction) => (
                  <DirectionCell
                    key={direction}
                    direction={direction}
                    spin={look.driftSpin}
                    selected={look.driftDirection === direction}
                    disabled={driftControlsDisabled}
                    onPick={(d) => update({ driftDirection: d })}
                  />
                ))}
              </div>
              <p className="setting-note">Moves {DRIFT_LABELS[look.driftDirection]}.</p>
            </div>

            {look.driftDirection === 'circle' && (
              <div className="drift-spin" role="radiogroup" aria-label="Circle direction">
                <div className="segmented">
                  {DRIFT_SPINS.map((spin) => (
                    <label key={spin} data-selected={look.driftSpin === spin}>
                      <input
                        type="radio"
                        name="drift-spin"
                        value={spin}
                        checked={look.driftSpin === spin}
                        disabled={driftControlsDisabled}
                        onChange={() => update({ driftSpin: spin })}
                      />
                      <span>{SPIN_LABELS[spin]}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}

            <div className="drift-speed">
              <label htmlFor="drift-speed" className="setting-label">
                Speed
              </label>
              <div className="range-row">
                <span aria-hidden="true">Slower</span>
                <input
                  id="drift-speed"
                  type="range"
                  min={DRIFT_SPEED_MIN}
                  max={DRIFT_SPEED_MAX}
                  step={1}
                  value={look.driftSpeed}
                  disabled={driftControlsDisabled}
                  aria-valuetext={`${speedWord(look.driftSpeed)}, ${look.driftSpeed} of ${DRIFT_SPEED_MAX}`}
                  onChange={(e) => update({ driftSpeed: Number(e.target.value) })}
                />
                <span aria-hidden="true">Faster</span>
              </div>
            </div>
          </fieldset>

          <div className="setting setting-row">
            <div>
              <label htmlFor="motion-toggle" className="setting-label">
                Gentle animation
              </label>
              {reducedMotion && <p className="setting-note">Off because your device asks for reduced motion.</p>}
            </div>
            <button
              id="motion-toggle"
              type="button"
              role="switch"
              aria-checked={motionOn}
              className="switch"
              disabled={reducedMotion}
              onClick={() => update({ motion: !settings.motion })}
            >
              <span className="switch-knob" />
              <span className="visually-hidden">{motionOn ? 'On' : 'Off'}</span>
            </button>
          </div>

          <div className="setting setting-row">
            <div>
              <label htmlFor="images-toggle" className="setting-label">
                Load images in HTML mail
              </label>
              <p className="setting-note">Turn off to stop senders learning when you open a message. You can still load images one message at a time.</p>
            </div>
            <button
              id="images-toggle"
              type="button"
              role="switch"
              aria-checked={settings.remoteImages}
              className="switch"
              onClick={() => update({ remoteImages: !settings.remoteImages })}
            >
              <span className="switch-knob" />
              <span className="visually-hidden">{settings.remoteImages ? 'On' : 'Off'}</span>
            </button>
          </div>

          <fieldset className="setting">
            <legend>Text size</legend>
            <div className="segmented" role="radiogroup" aria-label="Text size">
              {FONT_SCALES.map((scale: FontScale) => (
                <label key={scale} data-selected={settings.fontScale === scale}>
                  <input type="radio" name="font-scale" value={scale} checked={settings.fontScale === scale} onChange={() => update({ fontScale: scale })} />
                  <span>{scale}%</span>
                </label>
              ))}
            </div>
          </fieldset>
        </div>

        <footer className="dialog-footer">
          <button type="button" className="button button-danger" onClick={signOut}>
            {mock ? 'Leave sample inbox' : 'Sign out'}
          </button>
        </footer>
      </div>
    </div>
  );
}

interface DirectionCellProps {
  direction: DriftDirection;
  spin: DriftSpin;
  selected: boolean;
  disabled: boolean;
  onPick: (direction: DriftDirection) => void;
}

function DirectionCell({ direction, spin, selected, disabled, onPick }: DirectionCellProps) {
  const isCircle = direction === 'circle';
  return (
    <label className="drift-cell" data-selected={selected} data-direction={direction}>
      <input
        type="radio"
        name="drift-direction"
        value={direction}
        checked={selected}
        disabled={disabled}
        aria-label={`Drift ${DRIFT_LABELS[direction]}`}
        onChange={() => onPick(direction)}
      />
      {isCircle ? (
        <svg viewBox="0 0 16 16" width="22" height="22" aria-hidden="true" focusable="false" style={{ transform: spin === 'ccw' ? 'scaleX(-1)' : undefined }}>
          <path d="M13 8a5 5 0 1 1-1.7-3.8M13 2.5v3h-3" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : (
        <svg viewBox="0 0 16 16" width="20" height="20" aria-hidden="true" focusable="false" style={{ transform: `rotate(${ARROW_DEGREES[direction]}deg)` }}>
          <path d="M2 8h10M8 3l5 5-5 5" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
    </label>
  );
}
