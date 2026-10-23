import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsDialog } from '@/components/SettingsDialog';
import { SettingsProvider } from '@/components/SettingsProvider';
import { DEFAULT_SETTINGS, LOOK_KEY, SETTINGS_KEY, parseLook, type Settings } from '@/lib/settings';
import { lookJson } from '../helpers/look';

const signOut = vi.hoisted(() => vi.fn());
const authState = vi.hoisted(() => ({ mock: false }));

vi.mock('@/components/AuthProvider', () => ({
  useAuth: () => ({ signOut, mock: authState.mock }),
}));

function stored(): Settings {
  return JSON.parse(window.localStorage.getItem(SETTINGS_KEY) ?? '{}') as Settings;
}

/** Mount with saved settings. The random look is off unless a test asks for it. */
function mount(saved: Partial<Settings> = {}, reducedMotion = false) {
  window.localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...DEFAULT_SETTINGS, shuffle: false, ...saved }));
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: reducedMotion && query.includes('reduced-motion'),
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia;
  render(
    <SettingsProvider>
      <SettingsDialog onClose={() => undefined} />
    </SettingsProvider>,
  );
  return userEvent.setup();
}

beforeEach(() => {
  signOut.mockReset();
  authState.mock = false;
});

describe('Settings: background drift', () => {
  it('defaults to drifting down and to the right, slowly', () => {
    mount();
    expect(screen.getByRole('switch', { name: /Let the background drift/ })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: 'Drift down and to the right' })).toBeChecked();
    expect(screen.getByRole('slider', { name: 'Speed' })).toHaveValue('2');
    expect(screen.getByText('Moves down and to the right.')).toBeInTheDocument();
  });

  it('offers the eight compass directions and a big circle', () => {
    mount();
    const names = screen.getAllByRole('radio', { name: /^Drift / }).map((r) => r.getAttribute('aria-label'));
    expect(names.sort()).toEqual(
      [
        'Drift down',
        'Drift down and to the left',
        'Drift down and to the right',
        'Drift in a big circle',
        'Drift to the left',
        'Drift to the right',
        'Drift up',
        'Drift up and to the left',
        'Drift up and to the right',
      ].sort(),
    );
  });

  it('lays the pad out as a compass with the circle in the middle', () => {
    mount();
    const order = Array.from(document.querySelectorAll('.drift-cell')).map((el) => el.getAttribute('data-direction'));
    expect(order).toEqual(['nw', 'n', 'ne', 'w', 'circle', 'e', 'sw', 's', 'se']);
  });

  it('saves a new direction', async () => {
    const user = mount();
    await user.click(screen.getByRole('radio', { name: 'Drift up and to the left' }));
    expect(screen.getByRole('radio', { name: 'Drift up and to the left' })).toBeChecked();
    expect(stored().driftDirection).toBe('nw');
    expect(screen.getByText('Moves up and to the left.')).toBeInTheDocument();
  });

  it('switches to the big circle and then offers which way round', async () => {
    const user = mount();
    expect(screen.queryByRole('radio', { name: 'Clockwise' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: 'Drift in a big circle' }));
    expect(stored().driftDirection).toBe('circle');
    expect(screen.getByText('Moves in a big circle.')).toBeInTheDocument();

    expect(screen.getByRole('radio', { name: 'Clockwise' })).toBeChecked();
    await user.click(screen.getByRole('radio', { name: 'Counterclockwise' }));
    expect(stored().driftSpin).toBe('ccw');
    expect(screen.getByRole('radio', { name: 'Counterclockwise' })).toBeChecked();

    await user.click(screen.getByRole('radio', { name: 'Drift to the right' }));
    expect(screen.queryByRole('radio', { name: 'Clockwise' })).not.toBeInTheDocument();
  });

  it('saves a new speed and describes it in words', () => {
    mount();
    const slider = screen.getByRole('slider', { name: 'Speed' });
    expect(slider).toHaveAttribute('aria-valuetext', 'Slow, 2 of 10');
    fireEvent.change(slider, { target: { value: '10' } });
    expect(stored().driftSpeed).toBe(10);
    expect(slider).toHaveAttribute('aria-valuetext', 'Fast, 10 of 10');
  });

  it('turns drifting off and on', async () => {
    const user = mount();
    await user.click(screen.getByRole('switch', { name: /Let the background drift/ }));
    expect(stored().drift).toBe(false);
    expect(document.documentElement.dataset.drift).toBe('off');
    await user.click(screen.getByRole('switch', { name: /Let the background drift/ }));
    expect(stored().drift).toBe(true);
    expect(document.documentElement.dataset.drift).toBe('on');
  });

  it('disables the drift controls and explains why when gentle animation is off', () => {
    mount({ motion: false });
    expect(screen.getByRole('switch', { name: /Let the background drift/ })).toBeDisabled();
    expect(screen.getByRole('slider', { name: 'Speed' })).toBeDisabled();
    expect(screen.getByRole('radio', { name: 'Drift down' })).toBeDisabled();
    expect(screen.getByRole('radio', { name: 'Drift in a big circle' })).toBeDisabled();
    expect(screen.getByText('Turn on gentle animation to let it drift.')).toBeInTheDocument();
  });

  it('disables the drift controls under reduced motion and says so', () => {
    mount({}, true);
    expect(screen.getByRole('switch', { name: /Let the background drift/ })).toBeDisabled();
    expect(screen.getAllByText('Off because your device asks for reduced motion.').length).toBeGreaterThan(0);
  });

  it('disables the drift controls when the pattern is Plain', () => {
    mount({ pattern: 'none' });
    expect(screen.getByRole('switch', { name: /Let the background drift/ })).toBeDisabled();
    expect(screen.getByText('Pick a pattern above to give it something to drift.')).toBeInTheDocument();
  });
});

describe('Settings: surprise me (random look)', () => {
  it('is on for a first-time visitor and shows the look actually on screen', () => {
    window.localStorage.clear();
    window.sessionStorage.setItem(LOOK_KEY, lookJson('moonlit', 'stardust'));
    render(
      <SettingsProvider>
        <SettingsDialog onClose={() => undefined} />
      </SettingsProvider>,
    );
    expect(screen.getByRole('switch', { name: /Surprise me/ })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: /Moonlit Window/ })).toBeChecked();
    expect(screen.getByRole('combobox', { name: 'Background pattern' })).toHaveValue('stardust');
    expect(screen.getByRole('button', { name: 'Shuffle now' })).toBeInTheDocument();
  });

  it('turns off when you pick a theme yourself, and keeps your pick', async () => {
    window.localStorage.clear();
    window.sessionStorage.setItem(LOOK_KEY, lookJson('moonlit', 'stardust'));
    const user = userEvent.setup();
    render(
      <SettingsProvider>
        <SettingsDialog onClose={() => undefined} />
      </SettingsProvider>,
    );
    await user.click(screen.getByRole('radio', { name: /Meadow Paper/ }));
    expect(stored()).toMatchObject({ shuffle: false, theme: 'meadow' });
    expect(screen.getByRole('switch', { name: /Surprise me/ })).toHaveAttribute('aria-checked', 'false');
    expect(document.documentElement.dataset.theme).toBe('meadow');
    expect(screen.queryByRole('button', { name: 'Shuffle now' })).not.toBeInTheDocument();
  });

  it('turns off when you pick a pattern yourself', async () => {
    window.localStorage.clear();
    window.sessionStorage.setItem(LOOK_KEY, lookJson('moonlit', 'stardust'));
    const user = userEvent.setup();
    render(
      <SettingsProvider>
        <SettingsDialog onClose={() => undefined} />
      </SettingsProvider>,
    );
    await user.selectOptions(screen.getByRole('combobox', { name: 'Background pattern' }), 'gingham');
    expect(stored()).toMatchObject({ shuffle: false, pattern: 'gingham' });
    expect(document.documentElement.dataset.pattern).toBe('gingham');
  });

  it('keeps what is on screen when you switch it off', async () => {
    window.localStorage.clear();
    window.sessionStorage.setItem(LOOK_KEY, lookJson('moonlit', 'clouds'));
    const user = userEvent.setup();
    render(
      <SettingsProvider>
        <SettingsDialog onClose={() => undefined} />
      </SettingsProvider>,
    );
    await user.click(screen.getByRole('switch', { name: /Surprise me/ }));
    expect(stored()).toMatchObject({ shuffle: false, theme: 'moonlit', pattern: 'clouds' });
    expect(document.documentElement.dataset.theme).toBe('moonlit');
    expect(document.documentElement.dataset.pattern).toBe('clouds');
  });

  it('picks a fresh look when switched back on, and Shuffle now changes it', async () => {
    const user = mount({ theme: 'meadow', pattern: 'gingham' });
    expect(screen.getByRole('switch', { name: /Surprise me/ })).toHaveAttribute('aria-checked', 'false');
    await user.click(screen.getByRole('switch', { name: /Surprise me/ }));
    expect(stored().shuffle).toBe(true);
    const first = parseLook(window.sessionStorage.getItem(LOOK_KEY));
    expect(first).not.toBeNull();
    expect(first).not.toEqual(lookJson('meadow', 'gingham') && JSON.parse(lookJson('meadow', 'gingham')));

    await user.click(screen.getByRole('button', { name: 'Shuffle now' }));
    const second = parseLook(window.sessionStorage.getItem(LOOK_KEY));
    expect(second).not.toBeNull();
    expect(second).not.toEqual(first);
    expect(document.documentElement.dataset.theme).toBe(second?.theme);
    expect(document.documentElement.dataset.pattern).toBe(second?.pattern);
  });

  it('leaves the drift on/off switch alone when the look is shuffled', async () => {
    const user = mount({ drift: false });
    await user.click(screen.getByRole('switch', { name: /Surprise me/ }));
    expect(stored().drift).toBe(false);
  });
});

describe('Settings: images in HTML mail', () => {
  it('loads images by default and can be switched off and on', async () => {
    const user = mount();
    const toggle = screen.getByRole('switch', { name: /Load images in HTML mail/ });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    await user.click(toggle);
    expect(stored().remoteImages).toBe(false);
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    await user.click(toggle);
    expect(stored().remoteImages).toBe(true);
  });
});

describe('Settings: leaving', () => {
  it('says Sign out for a Gmail session', async () => {
    const user = mount();
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(signOut).toHaveBeenCalled();
  });

  it('says Leave sample inbox in sample mode', () => {
    authState.mock = true;
    mount();
    expect(screen.getByRole('button', { name: 'Leave sample inbox' })).toBeInTheDocument();
  });
});
