import { env, envInt, envList, envBool, isAdmin, BotConfig } from '../src/config';

const KEY = 'LUMI_TEST_VAR';

function cfg(over: Partial<BotConfig> = {}): BotConfig {
  return {
    homeserver: '', userId: '', accessToken: '',
    e2eeEnabled: false, deviceId: '', cryptoPassword: '', cryptoSaveInterval: 60,
    prometheusUrl: '', hassUrl: '', hassToken: '', grafanaUrl: '', grafanaToken: '',
    httpAllowedDomains: [], weatherEnabled: false, logLevel: 'info',
    adminUsers: [], ...over,
  };
}

afterEach(() => {
  delete process.env[KEY];
});

describe('env', () => {
  test('returns the env var value', () => {
    process.env[KEY] = 'hello';
    expect(env(KEY)).toBe('hello');
  });
  test('returns fallback when unset', () => {
    expect(env(KEY, 'default')).toBe('default');
  });
  test('returns empty string by default', () => {
    expect(env(KEY)).toBe('');
  });
});

describe('envInt', () => {
  test('parses an integer', () => {
    process.env[KEY] = '42';
    expect(envInt(KEY)).toBe(42);
  });
  test('returns fallback when unset', () => {
    expect(envInt(KEY, 7)).toBe(7);
  });
  test('returns fallback for non-numeric value', () => {
    process.env[KEY] = 'abc';
    expect(envInt(KEY, 3)).toBe(3);
  });
});

describe('envList', () => {
  test('splits comma-separated values', () => {
    process.env[KEY] = 'a,b,c';
    expect(envList(KEY)).toEqual(['a', 'b', 'c']);
  });
  test('trims whitespace around entries', () => {
    process.env[KEY] = ' a , b , c ';
    expect(envList(KEY)).toEqual(['a', 'b', 'c']);
  });
  test('filters empty entries', () => {
    process.env[KEY] = 'a,,b';
    expect(envList(KEY)).toEqual(['a', 'b']);
  });
  test('returns empty array when unset', () => {
    expect(envList(KEY)).toEqual([]);
  });
});

describe('envBool', () => {
  test('returns true for "true"', () => {
    process.env[KEY] = 'true';
    expect(envBool(KEY)).toBe(true);
  });
  test('returns true for "1"', () => {
    process.env[KEY] = '1';
    expect(envBool(KEY)).toBe(true);
  });
  test('returns false for "false"', () => {
    process.env[KEY] = 'false';
    expect(envBool(KEY)).toBe(false);
  });
  test('returns fallback when unset', () => {
    expect(envBool(KEY, true)).toBe(true);
    expect(envBool(KEY, false)).toBe(false);
  });
});

describe('isAdmin', () => {
  const me = '@me:hs';
  const other = '@other:hs';

  test('explicit adminUsers: member allowed, non-member denied', () => {
    const c = cfg({ adminUsers: [me] });
    expect(isAdmin(me, c)).toBe(true);
    expect(isAdmin(other, c)).toBe(false);
  });

  test('falls back to allowedUsers when adminUsers empty', () => {
    const c = cfg({ adminUsers: [], allowedUsers: [me] });
    expect(isAdmin(me, c)).toBe(true);
    expect(isAdmin(other, c)).toBe(false);
  });

  test('adminUsers takes precedence over allowedUsers', () => {
    const c = cfg({ adminUsers: [me], allowedUsers: [me, other] });
    expect(isAdmin(me, c)).toBe(true);
    expect(isAdmin(other, c)).toBe(false); // allowlisted but not admin
  });

  test('fail closed: no admins and no allowlist → nobody', () => {
    const c = cfg({ adminUsers: [], allowedUsers: [] });
    expect(isAdmin(me, c)).toBe(false);
    const c2 = cfg({ adminUsers: [] }); // allowedUsers undefined
    expect(isAdmin(me, c2)).toBe(false);
  });

  test('falsy sender is denied', () => {
    const c = cfg({ adminUsers: [me] });
    expect(isAdmin(null, c)).toBe(false);
    expect(isAdmin(undefined, c)).toBe(false);
    expect(isAdmin('', c)).toBe(false);
  });

  test('exact MXID match (no substring/case bleed)', () => {
    const c = cfg({ adminUsers: [me] });
    expect(isAdmin('@me:hs2', c)).toBe(false);
    expect(isAdmin('@ME:hs', c)).toBe(false);
    expect(isAdmin('me:hs', c)).toBe(false);
  });
});
