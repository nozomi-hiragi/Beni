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
  console.log(`Usage: beni [--help | --version]

Run beni without arguments to start the server on 127.0.0.1.
  BENI_DATA_DIR       Required. Data directory (relative paths resolve from the current directory).
  BENI_PORT           HTTP port (default: 3210).
  BENI_PUBLIC_ORIGIN  Optional exact HTTPS origin for reverse-proxy access.

The codex and claude CLIs are resolved from PATH.`);
} else if (args.length !== 0) {
  console.error('Unsupported arguments. See beni --help.');
  process.exitCode = 1;
} else if (!process.env.BENI_DATA_DIR?.trim()) {
  console.error('BENI_DATA_DIR must be set to a nonempty data directory. See beni --help.');
  process.exitCode = 1;
} else {
  const {startServer} = await import('./server');
  await startServer();
}
