import { expect, test } from 'bun:test';
import { prepareTailscale } from './tailscale';

const host = 'beni-node.example.ts.net';
const origin = `https://${host}`;
const status = { BackendState: 'Running', Self: { DNSName: `${host}.` } };
const executable = '/fake/bin/tailscale';
const target = 'http://127.0.0.1:3210';

function serving(proxy = target) {
  return { TCP: { 443: { HTTPS: true } }, Web: { [`${host}:443`]: { Handlers: { '/': { Proxy: proxy } } } } };
}

function fake(responses: unknown[], environment: NodeJS.ProcessEnv = {}) {
  const calls: string[][] = [];
  const prepare = () => prepareTailscale(environment, async (path, args) => {
    expect(path).toBe(executable);
    calls.push(args);
    if (responses.length === 0) throw new Error('unexpected command');
    const response = responses.shift();
    if (response instanceof Error) throw response;
    return typeof response === 'string' ? response : JSON.stringify(response);
  }, name => {
    expect(name).toBe('tailscale');
    return executable;
  });
  return { calls, prepare };
}

test('discovers the node and configures HTTPS only after preflight and a fresh read', async () => {
  const { calls, prepare } = fake([status, {}, {}, '', serving()]);
  const setup = await prepare();
  expect(setup.origin).toBe(origin);
  expect(setup.port).toBe(3210);
  expect(calls).toEqual([['status', '--json'], ['serve', 'status', '--json']]);
  await setup.configure();
  expect(calls.slice(2)).toEqual([
    ['serve', 'status', '--json'],
    ['serve', '--bg', '--https=443', '--yes', target],
    ['serve', 'status', '--json'],
  ]);
});

test('uses a custom port and reuses an identical configuration alongside other listeners', async () => {
  const configuration = {
    ...serving('http://127.0.0.1:65535/'),
    Foreground: { session: { TCP: { 8443: { HTTPS: true } } } },
    AllowFunnel: { [`${host}:8443`]: true },
    Services: { 'svc:other': { TCP: { 443: { HTTPS: true } } } },
  };
  const { calls, prepare } = fake([status, configuration, configuration], { BENI_PORT: '65535', BENI_PUBLIC_ORIGIN: origin });
  const setup = await prepare();
  expect(setup.port).toBe(65535);
  await setup.configure();
  expect(calls).toEqual([['status', '--json'], ['serve', 'status', '--json'], ['serve', 'status', '--json']]);
});

test.each(['0', '', ' 1234', '42\n', '2.5', '0x10', '65536'])('rejects invalid BENI_PORT %j before invoking the CLI', async port => {
  const { calls, prepare } = fake([], { BENI_PORT: port });
  await expect(prepare()).rejects.toThrow('BENI_PORT');
  expect(calls).toEqual([]);
});

test.each([
  'beni.ts.net\n',
  'beni.ts.net\r',
  'http://beni.ts.net',
  'beni.ts.net:443',
  'beni.ts.net/path',
  'beni..ts.net',
  'beni-.ts.net',
  'beni-K.ts.net',
  'beni.example.org',
  'beni.ts.net..',
])('rejects an invalid DNS name %j before reading Serve status', async DNSName => {
  const { calls, prepare } = fake([{ ...status, Self: { DNSName } }]);
  await expect(prepare()).rejects.toThrow('DNS');
  expect(calls).toEqual([['status', '--json']]);
});

test('rejects an explicit origin mismatch before reading Serve status', async () => {
  const { calls, prepare } = fake([status], { BENI_PUBLIC_ORIGIN: `${origin}/` });
  await expect(prepare()).rejects.toThrow('BENI_PUBLIC_ORIGIN');
  expect(calls).toHaveLength(1);
});

const activeFunnel = { AllowFunnel: { [`${host}:443`]: true } };
const conflicts = [
  { TCP: { 443: { TCPForward: '127.0.0.1:7777' } } },
  { TCP: { 443: { HTTP: true } } },
  serving('http://127.0.0.1:5555'),
  { ...serving(), Web: { [`${host}:443`]: { Handlers: { '/': { Proxy: target }, '/other': { Text: 'other' } } } } },
  { Foreground: { session: serving() } },
  { ...serving(), ...activeFunnel },
  { Foreground: { session: activeFunnel } },
  { Foreground: { session: { TCP: { 443: { UnknownType: 'value' } } } } },
  { Foreground: { session: { UnknownProperty: true } } },
  { AllowFunnel: { [`${host}:443`]: 'true' } },
  { Web: [] },
  'invalid json',
];

test.each(conflicts.map((config, index) => [index, config] as const))('refuses Serve conflict or invalid configuration %i without changes', async (_, config) => {
  const { calls, prepare } = fake([status, config]);
  await expect(prepare()).rejects.toThrow('Tailscale');
  expect(calls).toHaveLength(2);
});

test('detects a conflict introduced between preflight and bind without updating Serve', async () => {
  const { calls, prepare } = fake([status, {}, activeFunnel]);
  const setup = await prepare();
  await expect(setup.configure()).rejects.toThrow('Funnel');
  expect(calls.slice(2)).toEqual([['serve', 'status', '--json']]);
});

test('fails when the Serve update is not applied', async () => {
  const { calls, prepare } = fake([status, null, null, '', {}]);
  const setup = await prepare();
  await expect(setup.configure()).rejects.toThrow('Tailscale Serve を設定できません');
  expect(calls).toHaveLength(5);
});

test('reports a missing CLI and a disconnected node', async () => {
  await expect(prepareTailscale({}, async () => { throw new Error('unexpected command'); }, () => null)).rejects.toThrow('CLI');
  const { calls, prepare } = fake([{ BackendState: 'NeedsLogin' }]);
  await expect(prepare()).rejects.toThrow('接続して');
  expect(calls).toHaveLength(1);
});

test('CLI failures omit private output', async () => {
  const privateOutput = new Error('secret.example.invalid');
  const { prepare } = fake([privateOutput]);
  await expect(prepare()).rejects.toThrow(/^Tailscale の状態を取得できませんでした。接続状態と実行権限を確認してください。$/);
  const setup = await fake([status, {}, {}, privateOutput]).prepare();
  await expect(setup.configure()).rejects.toThrow(/^Tailscale Serve を設定できませんでした。Tailscale の実行権限と HTTPS の有効化を確認してから再試行してください。$/);
});
