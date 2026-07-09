import { loadConfig } from '../src/config';

// Env vars we touch in this test file
const E2EE_VARS = [
  'MATRIX_USER_ID',
  'MATRIX_ACCESS_TOKEN',
  'MATRIX_E2EE',
  'MATRIX_DEVICE_ID',
  'MATRIX_CRYPTO_PASSWORD',
  'MATRIX_CRYPTO_SAVE_INTERVAL',
];

// Minimal required vars so loadConfig doesn't exit on the required-field guard
const BASE_ENV: Record<string, string> = {
  MATRIX_USER_ID: '@bot:matrix.org',
  MATRIX_ACCESS_TOKEN: 'tok_test',
};

beforeEach(() => {
  for (const [k, v] of Object.entries(BASE_ENV)) process.env[k] = v;
});

afterEach(() => {
  for (const k of E2EE_VARS) delete process.env[k];
});

describe('E2EE config', () => {
  test('e2eeEnabled defaults to false when MATRIX_E2EE is unset', () => {
    const config = loadConfig();
    expect(config.e2eeEnabled).toBe(false);
  });

  test('e2eeEnabled is true when MATRIX_E2EE=true', () => {
    process.env.MATRIX_E2EE = 'true';
    process.env.MATRIX_DEVICE_ID = 'DEVICEABC';
    const config = loadConfig();
    expect(config.e2eeEnabled).toBe(true);
    expect(config.deviceId).toBe('DEVICEABC');
  });

  test('allows MATRIX_E2EE=true without MATRIX_DEVICE_ID (auto-detected at runtime)', () => {
    process.env.MATRIX_E2EE = 'true';
    const config = loadConfig();
    expect(config.e2eeEnabled).toBe(true);
    expect(config.deviceId).toBe(''); // blank — will be auto-detected via whoami
  });

  test('deviceId is populated even when e2eeEnabled is false', () => {
    process.env.MATRIX_DEVICE_ID = 'MYDEVICE';
    const config = loadConfig();
    expect(config.e2eeEnabled).toBe(false);
    expect(config.deviceId).toBe('MYDEVICE');
  });

  test('cryptoPassword is set from MATRIX_CRYPTO_PASSWORD', () => {
    process.env.MATRIX_E2EE = 'true';
    process.env.MATRIX_DEVICE_ID = 'DEVICEABC';
    process.env.MATRIX_CRYPTO_PASSWORD = 'supersecret';
    const config = loadConfig();
    expect(config.cryptoPassword).toBe('supersecret');
  });

  test('cryptoPassword defaults to empty string', () => {
    const config = loadConfig();
    expect(config.cryptoPassword).toBe('');
  });

  test('cryptoSaveInterval is parsed from MATRIX_CRYPTO_SAVE_INTERVAL', () => {
    process.env.MATRIX_CRYPTO_SAVE_INTERVAL = '120';
    const config = loadConfig();
    expect(config.cryptoSaveInterval).toBe(120);
  });

  test('cryptoSaveInterval defaults to 60', () => {
    const config = loadConfig();
    expect(config.cryptoSaveInterval).toBe(60);
  });
});
