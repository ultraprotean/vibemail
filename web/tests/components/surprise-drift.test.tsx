import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsDialog } from '@/components/SettingsDialog';
import { SettingsProvider } from '@/components/SettingsProvider';
import { DEFAULT_SETTINGS, LOOK_KEY, SETTINGS_KEY, parseLook, type Settings } from '@/lib/settings';
import { lookJson } from '../helpers/look';

vi.mock('@/components/AuthProvider', () => ({
  useAuth: () => ({ signOut: vi.fn(), mock: false }),
}));

const RANDOM = lookJson('moonlit', 'stardust', { driftDirection: 'nw', driftSpeed: 4, driftSpin: 'ccw' });

function stored(): Settings {
  return JSON.parse(window.localStorage.getItem(SETTINGS_KEY) ?? '{}') as Settings;
}

/** A first-time visitor whose random look for this tab is `look`. */
function mountShuffled(look = RANDOM) {
  window.localStorage.clear();
  window.sessionStorage.setItem(LOOK_KEY, look);
  render(
    <SettingsProvider>
      <SettingsDialog onClose={() => undefined} />
    </SettingsProvider>,
  );
  return userEvent.setup();
}

/** A visitor with saved settings (random look off unless overridden). */
function mountSaved(saved: Partial<Settings>) {
  window.localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...DEFAULT_SETTINGS, shuffle: false, ...saved }));
  render(
    <SettingsProvider>
      <SettingsDialog onClose={() => undefined} />
    </SettingsProvider>,
  );
  return userEvent.setup();
}

beforeEach(() => {
  window.sessionStorage.clear();
});

describe('Surprise me includes the drift', () => {
  it('shows the random direction and speed on the pad and slider, not the saved defaults', () => {
    mountShuffled();
    expect(screen.getByRole('radio', { name: 'Drift up and to the left' })).toBeChecked();
    expect(screen.getByText('Moves up and to the left.')).toBeInTheDocument();
    expect(screen.getByRole('slider', { name: 'Speed' })).toHaveValue('4');
    expect(screen.getByRole('slider', { name: 'Speed' })).toHaveAttribute('aria-valuetext', 'Medium, 4 of 10');
  });

  it('shows the random circle and its spin', () => {
    mountShuffled(lookJson('meadow', 'clouds', { driftDirection: 'circle', driftSpeed: 3, driftSpin: 'ccw' }));
    expect(screen.getByRole('radio', { name: 'Drift in a big circle' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Counterclockwise' })).toBeChecked();
  });

  it('keeps the theme, pattern and other drift choices when you pick a speed', () => {
    mountShuffled();
    fireEvent.change(screen.getByRole('slider', { name: 'Speed' }), { target: { value: '5' } });
    expect(stored()).toMatchObject({ shuffle: false, theme: 'moonlit', pattern: 'stardust', driftDirection: 'nw', driftSpeed: 5, driftSpin: 'ccw' });
    expect(document.documentElement.dataset.theme).toBe('moonlit');
    expect(document.documentElement.dataset.pattern).toBe('stardust');
    expect(screen.getByRole('radio', { name: 'Drift up and to the left' })).toBeChecked();
    expect(screen.getByRole('switch', { name: /Surprise me/ })).toHaveAttribute('aria-checked', 'false');
  });

  it('keeps the theme, pattern and speed when you pick a direction', async () => {
    const user = mountShuffled();
    await user.click(screen.getByRole('radio', { name: 'Drift to the right' }));
    expect(stored()).toMatchObject({ shuffle: false, theme: 'moonlit', pattern: 'stardust', driftDirection: 'e', driftSpeed: 4 });
    expect(screen.getByRole('slider', { name: 'Speed' })).toHaveValue('4');
  });

  it('keeps the random pattern and drift when you pick a theme', async () => {
    const user = mountShuffled();
    await user.click(screen.getByRole('radio', { name: /Meadow Paper/ }));
    expect(stored()).toMatchObject({ shuffle: false, theme: 'meadow', pattern: 'stardust', driftDirection: 'nw', driftSpeed: 4, driftSpin: 'ccw' });
    expect(document.documentElement.dataset.theme).toBe('meadow');
    expect(document.documentElement.dataset.pattern).toBe('stardust');
  });

  it('keeps the random theme and drift when you pick a pattern', async () => {
    const user = mountShuffled();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Background pattern' }), 'gingham');
    expect(stored()).toMatchObject({ shuffle: false, theme: 'moonlit', pattern: 'gingham', driftDirection: 'nw', driftSpeed: 4 });
    expect(document.documentElement.dataset.theme).toBe('moonlit');
  });

  it('keeps everything on screen, drift included, when you switch Surprise me off', async () => {
    const user = mountShuffled();
    await user.click(screen.getByRole('switch', { name: /Surprise me/ }));
    expect(stored()).toMatchObject({ shuffle: false, theme: 'moonlit', pattern: 'stardust', driftDirection: 'nw', driftSpeed: 4, driftSpin: 'ccw' });
    expect(screen.getByRole('radio', { name: 'Drift up and to the left' })).toBeChecked();
    expect(screen.getByRole('slider', { name: 'Speed' })).toHaveValue('4');
  });

  it('picks a complete new random look, drift included, when switched back on, and keeps your saved choices underneath', async () => {
    const user = mountSaved({ driftDirection: 'e', driftSpeed: 7, driftSpin: 'ccw' });
    expect(screen.getByRole('radio', { name: 'Drift to the right' })).toBeChecked();
    expect(screen.getByRole('slider', { name: 'Speed' })).toHaveValue('7');

    await user.click(screen.getByRole('switch', { name: /Surprise me/ }));
    const look = parseLook(window.sessionStorage.getItem(LOOK_KEY));
    expect(look).not.toBeNull();
    expect(look?.driftSpeed).toBeLessThanOrEqual(5);
    expect(screen.getByRole('slider', { name: 'Speed' })).toHaveValue(String(look?.driftSpeed));
    expect(stored()).toMatchObject({ shuffle: true, driftDirection: 'e', driftSpeed: 7 });
  });

  it('Shuffle now picks a different complete look', async () => {
    const user = mountShuffled();
    const before = window.sessionStorage.getItem(LOOK_KEY);
    await user.click(screen.getByRole('button', { name: 'Shuffle now' }));
    const after = parseLook(window.sessionStorage.getItem(LOOK_KEY));
    expect(after).not.toBeNull();
    expect(JSON.stringify(after)).not.toBe(before);
  });

  it('leaves the drift on/off switch alone', async () => {
    const user = mountSaved({ drift: false });
    await user.click(screen.getByRole('switch', { name: /Surprise me/ }));
    expect(stored().drift).toBe(false);
  });
});
