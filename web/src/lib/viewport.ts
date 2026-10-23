import { useEffect } from 'react';

/** Maximum compose drawer height on mobile, as a share of the visual viewport. */
export const DRAWER_MAX_VIEWPORT_PERCENT = 58;
export const DRAWER_MAX_VIEWPORT_SHARE = DRAWER_MAX_VIEWPORT_PERCENT / 100;

export interface ViewportMetrics {
  height: number;
  /** Gap between the layout viewport's bottom edge and the visual viewport (keyboard height). */
  bottomInset: number;
}

/** Visual viewport metrics: it shrinks when an on-screen keyboard opens. */
export function readViewport(win: Window = window): ViewportMetrics {
  const vv = win.visualViewport;
  if (!vv) return { height: win.innerHeight, bottomInset: 0 };
  return { height: vv.height, bottomInset: Math.max(0, win.innerHeight - (vv.height + vv.offsetTop)) };
}

/** Pixel height the drawer may occupy for a given viewport height. */
export function drawerMaxHeight(viewportHeight: number): number {
  return Math.floor((viewportHeight * DRAWER_MAX_VIEWPORT_PERCENT) / 100);
}

/**
 * Keeps `--vv-h` (visual viewport height) and `--vv-bottom` (keyboard inset) on the root so
 * the compose drawer can cap itself at 58% of what is actually visible.
 */
export function useVisualViewportVars(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const root = document.documentElement;
    const update = () => {
      const { height, bottomInset } = readViewport();
      root.style.setProperty('--vv-h', `${height}px`);
      root.style.setProperty('--vv-bottom', `${bottomInset}px`);
    };
    update();
    const vv = window.visualViewport;
    vv?.addEventListener('resize', update);
    vv?.addEventListener('scroll', update);
    window.addEventListener('resize', update);
    return () => {
      vv?.removeEventListener('resize', update);
      vv?.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
      root.style.removeProperty('--vv-h');
      root.style.removeProperty('--vv-bottom');
    };
  }, [active]);
}
