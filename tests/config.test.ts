import { env, envInt, envList, envBool } from '../src/config';

const KEY = 'LUMI_TEST_VAR';

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
