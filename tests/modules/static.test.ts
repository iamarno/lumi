import { ModuleRegistry } from '../../src/registry';
import { BotConfig } from '../../src/config';

const mod = require('../../src/modules/core/static');

const mockConfig = {} as BotConfig;

async function invoke(registry: ModuleRegistry, name: string, args: string[] = []) {
  return registry.get(name)!.handler({
    args,
    roomId: '!room:matrix.org',
    event: {} as any,
    client: {} as any,
  });
}

describe('static module', () => {
  let registry: ModuleRegistry;

  beforeEach(() => {
    registry = new ModuleRegistry();
    mod.register(registry, mockConfig);
  });

  test('registers all expected commands', () => {
    for (const name of ['ping', 'uptime', 'echo', 'roll', 'flip', 'time']) {
      expect(registry.get(name)).toBeDefined();
    }
  });

  test('ping returns pong', async () => {
    expect(await invoke(registry, 'ping')).toContain('Pong');
  });

  test('uptime returns a formatted duration', async () => {
    expect(await invoke(registry, 'uptime')).toMatch(/\d+h \d+m \d+s/);
  });

  test('echo returns joined args', async () => {
    expect(await invoke(registry, 'echo', ['hello', 'world'])).toBe('hello world');
  });

  test('echo with no args returns usage hint', async () => {
    expect(await invoke(registry, 'echo')).toContain('Usage');
  });

  test('roll returns a result for NdM notation', async () => {
    expect(await invoke(registry, 'roll', ['2d6'])).toMatch(/Rolled \*\*\d+\*\*/);
  });

  test('roll defaults to 1d6 when no args given', async () => {
    expect(await invoke(registry, 'roll')).toMatch(/d6/);
  });

  test('roll rejects invalid notation', async () => {
    expect(await invoke(registry, 'roll', ['invalid'])).toContain('Usage');
  });

  test('flip returns Heads or Tails', async () => {
    const result = await invoke(registry, 'flip');
    expect(result).toMatch(/Heads|Tails/);
  });

  test('time returns a UTC timestamp', async () => {
    expect(await invoke(registry, 'time')).toContain('UTC');
  });
});
