import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ModuleStore } from '../src/storage';

describe('ModuleStore', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi-storage-test-'));
    process.env.LUMI_STATE_DIR = tmpDir;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.LUMI_STATE_DIR;
  });

  test('returns fallback when key is absent', () => {
    const store = new ModuleStore('test');
    expect(store.get('missing', 42)).toBe(42);
  });

  test('stores and retrieves a value', () => {
    const store = new ModuleStore('test');
    store.set('foo', 'bar');
    expect(store.get('foo', null)).toBe('bar');
  });

  test('persists to disk', () => {
    const store = new ModuleStore('test');
    store.set('key', { nested: true });

    const store2 = new ModuleStore('test');
    expect(store2.get<{ nested: boolean }>('key', { nested: false })).toEqual({ nested: true });
  });

  test('deletes a key', () => {
    const store = new ModuleStore('test');
    store.set('x', 1);
    store.delete('x');
    expect(store.get('x', 99)).toBe(99);
  });

  test('uses module name for filename', () => {
    const store = new ModuleStore('mymod');
    store.set('a', 1);
    expect(fs.existsSync(path.join(tmpDir, 'mymod.json'))).toBe(true);
  });

  test('returns fallback when file is corrupt', () => {
    fs.writeFileSync(path.join(tmpDir, 'bad.json'), 'not json', 'utf8');
    const store = new ModuleStore('bad');
    expect(store.get('anything', 'default')).toBe('default');
  });
});
