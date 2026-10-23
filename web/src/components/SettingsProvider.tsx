'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  DEFAULT_SETTINGS,
  applySettings,
  LOOK_FIELDS,
  effectiveLook,
  loadLook,
  loadSettings,
  pickLook,
  saveLook,
  sameLook,
  saveSettings,
  type Look,
  type Settings,
} from '@/lib/settings';

interface SettingsContextValue {
  settings: Settings;
  /** The look actually on screen (theme, pattern and drift): this visit's random one when shuffling. */
  look: Look;
  /**
   * Change settings. Picking any part of the look yourself (theme, pattern, drift direction, speed
   * or spin) turns the random look off but keeps everything else that was on screen; turning it off
   * keeps all of it; turning it on picks a fresh one.
   */
  update: (patch: Partial<Settings>) => void;
  /** Pick a different random look right now. */
  reshuffle: () => void;
  /** True when the OS asks for reduced motion; animation is then off. */
  reducedMotion: boolean;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

function freshLook(not: Look | null): Look {
  let look = pickLook();
  for (let attempt = 0; attempt < 6 && not && sameLook(look, not); attempt += 1) {
    look = pickLook();
  }
  return look;
}

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [shuffled, setShuffled] = useState<Look | null>(null);
  const [reducedMotion, setReducedMotion] = useState(false);
  // Nothing is applied until storage has been read: the pre-paint script already set the right look.
  const [ready, setReady] = useState(false);
  const settingsRef = useRef(settings);
  const shuffledRef = useRef(shuffled);

  useEffect(() => {
    const loaded = loadSettings();
    const look = loaded.shuffle ? (loadLook() ?? freshLook(null)) : null;
    if (look) saveLook(look);
    settingsRef.current = loaded;
    shuffledRef.current = look;
    setSettings(loaded);
    setShuffled(look);
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReducedMotion(query.matches);
    const onChange = (event: MediaQueryListEvent) => setReducedMotion(event.matches);
    query.addEventListener('change', onChange);
    setReady(true);
    return () => query.removeEventListener('change', onChange);
  }, []);

  const look = useMemo(() => effectiveLook(settings, shuffled), [settings, shuffled]);

  useEffect(() => {
    if (ready) applySettings(settings, document.documentElement, reducedMotion, look);
  }, [ready, settings, reducedMotion, look]);

  const reshuffle = useCallback(() => {
    const next = freshLook(effectiveLook(settingsRef.current, shuffledRef.current));
    saveLook(next);
    shuffledRef.current = next;
    setShuffled(next);
  }, []);

  const update = useCallback(
    (patch: Partial<Settings>) => {
      const current = settingsRef.current;
      const showing = effectiveLook(current, shuffledRef.current);
      const choseLook = LOOK_FIELDS.some((field) => patch[field] !== undefined);
      const leavingShuffle = current.shuffle && (patch.shuffle === false || (choseLook && patch.shuffle === undefined));
      // Leaving the random look freezes everything on screen first, then applies the explicit pick,
      // so choosing a theme does not swap the pattern or drift back to older saved values.
      const next: Settings = leavingShuffle ? { ...current, ...showing, ...patch, shuffle: false } : { ...current, ...patch };
      saveSettings(next);
      settingsRef.current = next;
      setSettings(next);
      if (patch.shuffle === true) reshuffle();
    },
    [reshuffle],
  );

  const value = useMemo(() => ({ settings, look, update, reshuffle, reducedMotion }), [settings, look, update, reshuffle, reducedMotion]);
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings(): SettingsContextValue {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error('useSettings must be used inside SettingsProvider');
  return ctx;
}
