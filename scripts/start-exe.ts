import { access, readdir, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const executableRoot = resolve(root, 'dist/executables');
const buildIdPattern = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f-]+$/i;

async function isExecutable(path: string) {
  try {
    const file = await stat(path);
    if (!file.isFile()) return false;
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

let builds: string[] = [];
try {
  builds = (await readdir(executableRoot, {withFileTypes: true}))
    .filter(entry => entry.isDirectory() && buildIdPattern.test(entry.name))
    .map(entry => entry.name)
    .sort((a, b) => b.localeCompare(a));
} catch {
  // A missing executable directory is handled like an empty one below.
}

let executable: string | undefined;
for (const build of builds) {
  const candidate = resolve(executableRoot, build, 'beni');
  if (await isExecutable(candidate)) {
    executable = candidate;
    break;
  }
}

if (!executable) {
  console.error('実行ファイルがありません。先に bun run build:exe を実行してください。');
  process.exit(1);
}

const execve = (process as typeof process & {
  execve: (path: string, args: string[], env: NodeJS.ProcessEnv) => never;
}).execve;
execve(executable, [executable, ...process.argv.slice(2)], process.env);
