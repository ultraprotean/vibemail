import { existsSync, readFileSync } from 'node:fs';

/**
 * Guards the deployment config. Without an explicit output directory, Vercel serves the
 * project root as static files, which published CONTRACT.md, src/ and tests/ in production.
 */

interface VercelJson {
  outputDirectory?: string;
  rewrites?: Array<{ source: string; destination: string }>;
  crons?: Array<{ path: string; schedule: string }>;
}

const config: VercelJson = JSON.parse(readFileSync('vercel.json', 'utf8'));

describe('vercel.json', () => {
  it('serves static files only from public/', () => {
    expect(config.outputDirectory).toBe('public');
    expect(existsSync('public')).toBe(true);
  });

  it('keeps source, docs and secrets out of public/', () => {
    for (const name of ['CONTRACT.md', 'CLAUDE.md', 'src', 'tests', 'docs', '.env', 'package.json']) {
      expect(existsSync(`public/${name}`)).toBe(false);
    }
  });

  it.each([
    ['/', '/api/health'],
    ['/webhook/gmail', '/api/webhook/gmail'],
    ['/cron/renew-watch', '/api/cron/renew-watch'],
  ])('rewrites %s to %s', (source, destination) => {
    expect(config.rewrites).toContainEqual({ source, destination });
  });

  it('schedules the daily watch renewal', () => {
    expect(config.crons).toContainEqual({ path: '/api/cron/renew-watch', schedule: '0 6 * * *' });
  });

  it('has a function file behind every rewrite destination', () => {
    for (const { destination } of config.rewrites ?? []) {
      expect(existsSync(`${destination.slice(1)}.ts`)).toBe(true);
    }
  });
});
