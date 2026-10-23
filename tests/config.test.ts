import { readConfig } from '../src/config';

const complete: NodeJS.ProcessEnv = {
  GOOGLE_CLIENT_ID: 'client-id',
  GOOGLE_CLIENT_SECRET: 'client-secret',
  GOOGLE_REDIRECT_URI: 'https://api.example/api/v1/auth/google/callback',
  GOOGLE_PUBSUB_TOPIC: 'projects/p/topics/t',
  GOOGLE_PUBSUB_VERIFICATION_TOKEN: 'verify-token',
  SUPABASE_URL: 'https://db.example',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
  JWT_SECRET: 'jwt-secret',
  ENCRYPTION_KEY: 'a'.repeat(64),
  FRONTEND_URL: 'https://app.example',
  CRON_SECRET: 'cron-secret',
};

describe('readConfig', () => {
  it('reads every variable', () => {
    const config = readConfig(complete);
    expect(config).toEqual({
      googleClientId: 'client-id',
      googleClientSecret: 'client-secret',
      googleRedirectUri: 'https://api.example/api/v1/auth/google/callback',
      googlePubsubTopic: 'projects/p/topics/t',
      pubsubVerificationToken: 'verify-token',
      supabaseUrl: 'https://db.example',
      supabaseServiceRoleKey: 'service-role-key',
      jwtSecret: 'jwt-secret',
      encryptionKey: 'a'.repeat(64),
      frontendUrl: 'https://app.example',
      cronSecret: 'cron-secret',
    });
  });

  it('trims stray whitespace from every value, so a pasted tab cannot break Google sign-in', () => {
    const padded: NodeJS.ProcessEnv = {};
    for (const [name, value] of Object.entries(complete)) padded[name] = `\t ${value} \r\n`;
    expect(readConfig(padded)).toEqual(readConfig(complete));
  });

  it('fixes the exact case that broke production: a leading tab on the redirect address', () => {
    const config = readConfig({ ...complete, GOOGLE_REDIRECT_URI: '\thttps://api.example/api/v1/auth/google/callback' });
    expect(config.googleRedirectUri).toBe('https://api.example/api/v1/auth/google/callback');
    expect(config.googleRedirectUri.startsWith('https://')).toBe(true);
  });

  it('still removes trailing slashes from the frontend origin, after trimming', () => {
    expect(readConfig({ ...complete, FRONTEND_URL: ' https://app.example/// \n' }).frontendUrl).toBe('https://app.example');
  });

  it('names every missing variable', () => {
    const { JWT_SECRET: _jwt, CRON_SECRET: _cron, ...rest } = complete;
    expect(() => readConfig(rest)).toThrow('Missing environment variables: JWT_SECRET, CRON_SECRET');
  });

  it('treats an empty value or one that is only whitespace as missing', () => {
    expect(() => readConfig({ ...complete, JWT_SECRET: '' })).toThrow('JWT_SECRET');
    expect(() => readConfig({ ...complete, JWT_SECRET: '  \t\n ' })).toThrow('JWT_SECRET');
  });

  it('never changes a value\'s inner characters', () => {
    expect(readConfig({ ...complete, JWT_SECRET: ' has inner spaces ' }).jwtSecret).toBe('has inner spaces');
  });
});
