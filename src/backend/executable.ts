import { internalDataSqlArgument } from './data-sql';

declare const BENI_BUILD_IDENTITY: string;

const args = process.argv.slice(2);
const [argument] = args;
if (args.length === 1 && argument === internalDataSqlArgument) {
  const {runDataSqlChild} = await import('./data-sql-child');
  await runDataSqlChild();
} else if (args.length === 1 && (argument === '--version' || argument === '-v')) {
  console.log(BENI_BUILD_IDENTITY);
} else if (args.length === 1 && (argument === '--help' || argument === '-h')) {
  console.log(`Usage: beni [--tailscale | --help | --version]

Run beni without arguments to start the server on 127.0.0.1.
Use --tailscale to start Beni with HTTPS access inside your Tailscale network.
  BENI_DATA_DIR       Optional data directory (default: ~/Library/Application Support/Beni/data).
                      Relative paths resolve from the current directory.
  BENI_PORT           HTTP port (default: 3210).
  BENI_PUBLIC_ORIGIN  Optional exact HTTPS origin for reverse-proxy access.

The codex, claude and tailscale CLIs are resolved from PATH.`);
} else if (args.length === 1 && argument === '--tailscale') {
  const { prepareTailscale, TailscaleError } = await import('./tailscale');
  const { startServer } = await import('./server');
  const controller = new AbortController();
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  let ready = false;
  function onSignal() {
    controller.abort();
    if (ready) void server!.stop().then(() => process.exit(0), () => process.exit(1));
  }
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);
  try {
    const tailscale = await prepareTailscale(process.env, undefined, undefined, controller.signal);
    process.env.BENI_PUBLIC_ORIGIN = tailscale.origin;
    server = await startServer(controller.signal);
    if (server.port !== tailscale.port) throw new Error();
    await tailscale.configure();
    controller.signal.throwIfAborted();
    console.log(`Beni: ${tailscale.origin}/`);
    ready = true;
  } catch (error) {
    if (!controller.signal.aborted) {
      console.error(error instanceof TailscaleError ? error.message : 'Beni を起動できませんでした。データ保存先と BENI_PORT を確認してください。');
      process.exitCode = 1;
    }
    try {
      await server?.stop();
    } catch {
      process.exitCode = 1;
    } finally {
      process.off('SIGTERM', onSignal);
      process.off('SIGINT', onSignal);
    }
    process.exit(process.exitCode ?? 0);
  }
} else if (args.length !== 0) {
  console.error('Unsupported arguments. See beni --help.');
  process.exitCode = 1;
} else {
  const {startServer} = await import('./server');
  await startServer();
}
