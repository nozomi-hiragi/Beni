import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { frontendAssetPaths } from '../src/backend/frontend-assets';

const root = fileURLToPath(new URL('..', import.meta.url));

async function command(args: string[], stdout: 'inherit' | 'pipe' = 'inherit') {
  const child = Bun.spawn(args, {cwd: root, stdout, stderr: 'inherit'});
  const output = child.stdout ? new Response(child.stdout).text() : '';
  const [status, value] = await Promise.all([child.exited, output]);
  if (status !== 0) throw new Error(`${args[0]} ${args[1]} exited with status ${status}`);
  return value.trim();
}

async function buildExecutable() {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    throw new Error('build:exe requires macOS arm64.');
  }

  const [revision, status] = await Promise.all([
    command(['git', 'rev-parse', 'HEAD'], 'pipe'),
    command(['git', 'status', '--porcelain'], 'pipe'),
  ]);
  const time = new Date().toISOString();
  const buildId = `${time.replace(/[:.]/g, '-')}-${crypto.randomUUID()}`;
  const identity = `Beni ${buildId} (${revision}${status ? '-dirty' : ''})`;
  await command([process.execPath, 'run', 'build']);
  const assets = Object.fromEntries(await Promise.all(frontendAssetPaths.map(async path =>
    [path, await Bun.file(resolve(root, path)).text()],
  )));

  const outputRoot = resolve(root, 'dist/executables');
  const directory = resolve(outputRoot, buildId);
  const outfile = resolve(directory, 'beni');
  await mkdir(outputRoot, {recursive: true});
  await mkdir(directory);
  let staging: string | undefined;
  try {
    staging = await mkdtemp(join(tmpdir(), 'beni-exe-'));
    process.chdir(staging);
    const result = await Bun.build({
      root,
      entrypoints: [resolve(root, 'src/backend/executable.ts')],
      define: {
        BENI_BUILD_IDENTITY: JSON.stringify(identity),
        BENI_EMBEDDED_FRONTEND: JSON.stringify(assets),
      },
      env: 'disable',
      compile: {
        outfile,
        autoloadDotenv: false,
        autoloadBunfig: false,
      },
    });
    if (!result.success) throw new AggregateError(result.logs, 'Executable build failed');
  } catch (error) {
    await rm(directory, {recursive: true});
    throw error;
  } finally {
    process.chdir(root);
    if (staging) await rm(staging, {recursive: true});
  }
  console.log(outfile);
}

await buildExecutable();
