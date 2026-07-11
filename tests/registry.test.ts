import { ModuleRegistry, errMsg, renderHtml } from '../src/registry';

// ── errMsg ────────────────────────────────────────────────────────────────────

describe('errMsg', () => {
  test('returns message from an Error', () => {
    expect(errMsg(new Error('oops'))).toBe('oops');
  });
  test('stringifies a plain string', () => {
    expect(errMsg('raw')).toBe('raw');
  });
  test('stringifies a number', () => {
    expect(errMsg(42)).toBe('42');
  });
});

// ── renderHtml ────────────────────────────────────────────────────────────────

describe('renderHtml', () => {
  test('escapes &', () => expect(renderHtml('a & b')).toBe('a &amp; b'));
  test('escapes <', () => expect(renderHtml('a < b')).toBe('a &lt; b'));
  test('escapes >', () => expect(renderHtml('a > b')).toBe('a &gt; b'));
  test('renders **bold**', () => expect(renderHtml('**hi**')).toBe('<strong>hi</strong>'));
  test('renders `code`', () => expect(renderHtml('`x`')).toBe('<code>x</code>'));
  test('converts newlines to <br>', () => expect(renderHtml('a\nb')).toBe('a<br>b'));
});

// ── ModuleRegistry ────────────────────────────────────────────────────────────

describe('ModuleRegistry', () => {
  let registry: ModuleRegistry;

  beforeEach(() => {
    registry = new ModuleRegistry();
  });

  test('register and get a command', () => {
    registry.register({ name: 'foo', help: 'Foo', handler: async () => 'ok' });
    expect(registry.get('foo')).toBeDefined();
  });

  test('get is case-insensitive', () => {
    registry.register({ name: 'Foo', help: '', handler: async () => '' });
    expect(registry.get('FOO')).toBeDefined();
  });

  test('get returns undefined for unknown command', () => {
    expect(registry.get('nope')).toBeUndefined();
  });

  test('admin flag round-trips on a command', () => {
    registry.register({ name: 'secret', help: '', admin: true, handler: async () => '' });
    expect(registry.get('secret')?.admin).toBe(true);
    registry.register({ name: 'open', help: '', handler: async () => '' });
    expect(registry.get('open')?.admin).toBeUndefined();
  });

  test('moduleHelp overview contains command name', () => {
    registry.register({ name: 'bar', help: 'Bar help', handler: async () => '' });
    const text = registry.moduleHelp();
    expect(text).toContain('!bar');
  });

  test('moduleHelp detail contains command help text', () => {
    registry.registerModule('mymod', 'My module');
    registry.register({ name: 'bar', module: 'mymod', help: 'Bar help', handler: async () => '' });
    expect(registry.moduleHelp('mymod')).toContain('Bar help');
  });

  test('moduleHelp detail includes usage when provided', () => {
    registry.registerModule('mymod', 'My module');
    registry.register({ name: 'baz', module: 'mymod', help: 'h', usage: '<arg>', handler: async () => '' });
    expect(registry.moduleHelp('mymod')).toContain('<arg>');
  });

  test('moduleHelp detail includes longer description', () => {
    registry.registerModule('mymod', 'My module');
    registry.register({ name: 'baz', module: 'mymod', help: 'h', description: 'Longer explanation here', handler: async () => '' });
    expect(registry.moduleHelp('mymod')).toContain('Longer explanation here');
  });

  test('moduleHelp unknown module returns error message', () => {
    expect(registry.moduleHelp('nope')).toContain('Unknown module');
  });

  test('commandNames returns all registered names', () => {
    registry.register({ name: 'a', help: '', handler: async () => '' });
    registry.register({ name: 'b', help: '', handler: async () => '' });
    expect(registry.commandNames()).toEqual(expect.arrayContaining(['a', 'b']));
  });

  test('schedule silently drops task with no rooms', () => {
    jest.useFakeTimers();
    const client = { sendMessage: jest.fn() };
    registry.schedule({ name: 'x', intervalSecs: 10, rooms: [], handler: async () => 'hi' });
    registry.startScheduler(client as any);
    jest.advanceTimersByTime(15_000);
    expect(client.sendMessage).not.toHaveBeenCalled();
    jest.useRealTimers();
  });

  test('schedule silently drops task with zero interval', () => {
    jest.useFakeTimers();
    const client = { sendMessage: jest.fn() };
    registry.schedule({ name: 'x', intervalSecs: 0, rooms: ['!r:m.org'], handler: async () => 'hi' });
    registry.startScheduler(client as any);
    jest.advanceTimersByTime(15_000);
    expect(client.sendMessage).not.toHaveBeenCalled();
    jest.useRealTimers();
  });

  test('startScheduler sends message to all rooms after interval elapses', async () => {
    jest.useFakeTimers();
    const client = { sendMessage: jest.fn().mockResolvedValue(undefined) };
    registry.schedule({
      name: 'test',
      intervalSecs: 60,
      rooms: ['!room:matrix.org'],
      handler: async () => 'scheduled msg',
    });
    registry.startScheduler(client as any);
    jest.advanceTimersByTime(60_000);
    await Promise.resolve();
    await Promise.resolve();
    expect(client.sendMessage).toHaveBeenCalledWith(
      '!room:matrix.org',
      expect.objectContaining({ body: 'scheduled msg', msgtype: 'm.text' })
    );
    jest.useRealTimers();
  });

  test('registerReply and matchReply find a matching handler', () => {
    registry.registerReply({
      name: 'test',
      match: (_roomId, body) => body === 'hello',
      handler: async () => 'hi',
    });
    expect(registry.matchReply('!r:m.org', 'hello')).toBeDefined();
    expect(registry.matchReply('!r:m.org', 'hello')!.name).toBe('test');
  });

  test('matchReply returns undefined when no handler matches', () => {
    registry.registerReply({
      name: 'strict',
      match: (_roomId, body) => body === 'exact',
      handler: async () => 'ok',
    });
    expect(registry.matchReply('!r:m.org', 'not-exact')).toBeUndefined();
  });

  test('matchReply passes roomId to match function', () => {
    const matchFn = jest.fn().mockReturnValue(true);
    registry.registerReply({ name: 'r', match: matchFn, handler: async () => null });
    registry.matchReply('!specific:room', 'body');
    expect(matchFn).toHaveBeenCalledWith('!specific:room', 'body');
  });

  test('startScheduler skips posting when handler returns null', async () => {
    jest.useFakeTimers();
    const client = { sendMessage: jest.fn() };
    registry.schedule({
      name: 'noop',
      intervalSecs: 60,
      rooms: ['!room:matrix.org'],
      handler: async () => null,
    });
    registry.startScheduler(client as any);
    jest.advanceTimersByTime(60_000);
    await Promise.resolve();
    expect(client.sendMessage).not.toHaveBeenCalled();
    jest.useRealTimers();
  });
});
