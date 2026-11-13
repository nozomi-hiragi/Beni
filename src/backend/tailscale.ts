const serveStatusArgs = ['serve', 'status', '--json'];
const commandTimeoutMs = 15_000;
const maxOutputBytes = 16 * 1024 * 1024;

type RunCommand = (executable: string, args: string[], signal?: AbortSignal) => Promise<string>;
type JsonObject = Record<string, unknown>;

export class TailscaleError extends Error {}

const invalidConfig = () => new TailscaleError('Tailscale Serve の設定を確認できませんでした。');
const conflict = () => new TailscaleError('Tailscale Serve の HTTPS ポート 443 に既存の設定があります。');
const funnel = () => new TailscaleError('Tailscale Funnel が HTTPS ポート 443 で有効です。');
const setupFailed = () => new TailscaleError('Tailscale Serve を設定できませんでした。Tailscale の実行権限と HTTPS の有効化を確認してから再試行してください。');

function object(value: unknown): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalidConfig();
  return value as JsonObject;
}

function optionalObject(value: unknown): JsonObject {
  return value === undefined ? {} : object(value);
}

function json(output: string): unknown {
  try {
    return JSON.parse(output);
  } catch {
    throw invalidConfig();
  }
}

async function runCommand(executable: string, args: string[], signal?: AbortSignal): Promise<string> {
  const child = Bun.spawn([executable, ...args], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'ignore',
    killSignal: 'SIGKILL',
    signal,
  });
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        let bytes = 0;
        let output = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > maxOutputBytes) throw new Error();
          output += decoder.decode(value, { stream: true });
        }
        if (await child.exited !== 0) throw new Error();
        return output + decoder.decode();
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error()), commandTimeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    void reader.cancel().catch(() => {});
    await child.exited;
  }
}

function dnsName(status: unknown): string {
  const info = object(status);
  if (info.BackendState !== 'Running') {
    throw new TailscaleError('Tailscale に接続してから再試行してください。');
  }
  const value = object(info.Self).DNSName;
  const host = typeof value === 'string' && !/[^a-zA-Z0-9.-]/.test(value)
    ? (value.endsWith('.') ? value.slice(0, -1) : value).toLowerCase()
    : '';
  const labels = host.split('.');
  const validLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
  if (host.length > 253 || labels.length < 3 || !host.endsWith('.ts.net') || !labels.every(label => validLabel.test(label))) {
    throw new TailscaleError('Tailscale の DNS 名を確認できませんでした。');
  }
  return host;
}

function portNumber(key: string): number {
  const port = Number(key);
  if (!key || /\D/.test(key) || !Number.isInteger(port) || port < 1 || port > 65535) throw invalidConfig();
  return port;
}

function hostPort(key: string): number {
  const separator = key.lastIndexOf(':');
  if (separator <= 0) throw invalidConfig();
  return portNumber(key.slice(separator + 1));
}

function serveOn443(config: JsonObject, host: string) {
  // Services have their own virtual IP addresses and do not occupy the node's port.
  if (Object.keys(config).some(key => !['TCP', 'Web', 'AllowFunnel', 'Foreground', 'Services'].includes(key))) {
    throw invalidConfig();
  }
  optionalObject(config.Services);
  const tcp = Object.entries(optionalObject(config.TCP)).filter(([key]) => portNumber(key) === 443);
  const web = Object.entries(optionalObject(config.Web)).filter(([key]) => hostPort(key) === 443);
  for (const [key, enabled] of Object.entries(optionalObject(config.AllowFunnel))) {
    const port = hostPort(key);
    if (typeof enabled !== 'boolean') throw invalidConfig();
    if (enabled && port === 443 && key.slice(0, key.lastIndexOf(':')).toLowerCase().replace(/\.$/, '') === host) {
      throw funnel();
    }
  }
  return { tcp, web };
}

function matchingServe(config: unknown, host: string, target: string): boolean {
  // Tailscale emits JSON null when no Serve config exists.
  if (config === null) return false;
  const background = object(config);
  const { tcp, web } = serveOn443(background, host);
  for (const entry of Object.values(optionalObject(background.Foreground))) {
    const foreground = object(entry);
    const ports = serveOn443(foreground, host);
    if (foreground.Foreground !== undefined || ports.tcp.length || ports.web.length) throw conflict();
  }
  if (!tcp.length && !web.length) return false;
  if (tcp.length !== 1 || tcp[0]![0] !== '443' || web.length !== 1 || web[0]![0] !== `${host}:443`) throw conflict();
  const https = object(tcp[0]![1]);
  const site = object(web[0]![1]);
  const handlers = object(site.Handlers);
  const root = object(handlers['/']);
  if (Object.keys(https).length !== 1 || https.HTTPS !== true ||
      Object.keys(site).length !== 1 || Object.keys(handlers).length !== 1 ||
      Object.keys(root).length !== 1 || (root.Proxy !== target && root.Proxy !== `${target}/`)) {
    throw conflict();
  }
  return true;
}

export async function prepareTailscale(
  environment: NodeJS.ProcessEnv = process.env,
  run: RunCommand = runCommand,
  find: (name: string) => string | null = Bun.which,
  signal?: AbortSignal,
) {
  const executable = find('tailscale');
  if (!executable) throw new TailscaleError('Tailscale CLI が見つかりません。tailscale を PATH に追加してください。');

  const rawPort = environment.BENI_PORT ?? '3210';
  const port = Number(rawPort);
  if (!rawPort || /\D/.test(rawPort) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new TailscaleError('--tailscale の BENI_PORT は 1〜65535 の整数で指定してください。');
  }
  const target = `http://127.0.0.1:${port}`;

  let status: unknown;
  try {
    status = JSON.parse(await run(executable, ['status', '--json'], signal));
  } catch {
    throw new TailscaleError('Tailscale の状態を取得できませんでした。接続状態と実行権限を確認してください。');
  }
  const host = dnsName(status);
  const origin = `https://${host}`;
  if (environment.BENI_PUBLIC_ORIGIN !== undefined && environment.BENI_PUBLIC_ORIGIN !== origin) {
    throw new TailscaleError('BENI_PUBLIC_ORIGIN が Tailscale の HTTPS オリジンと一致しません。');
  }

  async function readServe() {
    let output: string;
    try {
      output = await run(executable!, serveStatusArgs, signal);
    } catch {
      throw new TailscaleError('Tailscale Serve の状態を取得できませんでした。接続状態と実行権限を確認してください。');
    }
    return matchingServe(json(output), host, target);
  }

  await readServe();
  return {
    origin,
    port,
    async configure() {
      // Read again after the loopback bind to catch changes during Beni startup.
      if (await readServe()) return;
      try {
        signal?.throwIfAborted();
        await run(executable, ['serve', '--bg', '--https=443', '--yes', target], signal);
      } catch {
        throw setupFailed();
      }
      if (!await readServe()) throw setupFailed();
    },
  };
}
