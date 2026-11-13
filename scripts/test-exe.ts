import assert from 'node:assert/strict';
import { chmod, copyFile, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Subprocess } from 'bun';
import type { ClientMessage, ServerMessage, TerminalSession } from '../src/shared/communication';
import type { DataSqlCatalog, DataSqlResult } from '../src/shared/data-browser';

type NamedRecord = {id: string; name: string};
type Conversation = {
  id: string;
  messages: {id: string; role: string; content: string; status: string}[];
};
type LocalSocket = new (url: string, options: {headers: {origin: string}}) => WebSocket;

const deadline = 10_000;

async function waitFor<T>(label: string, check: () => T | undefined | Promise<T | undefined>): Promise<T> {
  const end = performance.now() + deadline;
  do {
    const result = await check();
    if (result !== undefined) return result;
    await Bun.sleep(25);
  } while (performance.now() < end);
  throw new Error(`Timed out waiting for ${label}`);
}

function processExists(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

function sqlChild(parentPid: number, executable: string) {
  const result = Bun.spawnSync(['/bin/ps', '-axo', 'pid=,ppid=,command='], {timeout: deadline});
  assert.equal(result.exitCode, 0, result.stderr.toString());
  for (const line of result.stdout.toString().trim().split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (match && Number(match[2]) === parentPid && match[3] === executable + ' --internal-data-sql') {
      return Number(match[1]);
    }
  }
}

async function stop(child: Subprocess) {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), deadline);
  try {
    const code = await child.exited;
    assert.equal(code, 0, `Server shutdown failed (signal: ${child.signalCode})`);
  } finally {
    clearTimeout(timer);
  }
}

async function checkAssets(origin: string) {
  async function asset(path: string, contentType: RegExp) {
    const response = await fetch(origin + path, {signal: AbortSignal.timeout(deadline)});
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get('content-type') ?? '', contentType, path);
    return response;
  }
  async function textAsset(path: string, contentType: RegExp) {
    const body = await (await asset(path, contentType)).text();
    assert.ok(body.trim().length, `${path} is empty`);
    return body;
  }
  const html = await textAsset('/', /^text\/html\b/i);
  for (const path of ['/ui/build/app.js', '/ui/style.css', '/ui/generated.css']) {
    assert.ok(html.includes(path), `${path} is missing from the HTML`);
    const contentType = path.endsWith('.css') ? /^text\/css\b/i : /^(?:text|application)\/javascript\b/i;
    await textAsset(path, contentType);
  }

  assert.match(html, /rel="manifest" href="\/manifest\.webmanifest"/);
  assert.match(html, /rel="apple-touch-icon"[^>]* href="\/icons\/apple-touch-icon\.png"/);
  const manifest = await (await asset('/manifest.webmanifest', /^application\/manifest\+json\b/i)).json();
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.display, 'standalone');
  assert.deepEqual(manifest.icons.map((icon: {src: string}) => icon.src), ['/icons/icon-192.png', '/icons/icon-512.png']);
  for (const name of ['icon-192.png', 'icon-512.png', 'apple-touch-icon.png']) {
    const path = '/icons/' + name;
    const png = await (await asset(path, /^image\/png\b/i)).arrayBuffer();
    const original = await Bun.file(join(import.meta.dir, '../src/frontend/pwa/icons', name)).arrayBuffer();
    assert.deepEqual(new Uint8Array(png), new Uint8Array(original), path);
  }
}

async function checkTerminal(origin: string, projectId: string, terminal: TerminalSession, onPid: (pid: number) => void) {
  assert.equal(terminal.status, 'running');
  const socket = new (WebSocket as unknown as LocalSocket)(origin.replace('http:', 'ws:') + '/api/ws', {headers: {origin}});
  const messages: ServerMessage[] = [];
  socket.addEventListener('message', event => messages.push(JSON.parse(String(event.data)) as ServerMessage));
  try {
    await waitFor('WebSocket connection', () => {
      assert.ok(socket.readyState < WebSocket.CLOSING, 'WebSocket connection closed');
      if (socket.readyState === WebSocket.OPEN) return true;
    });
    const send = (message: ClientMessage) => socket.send(JSON.stringify(message));
    send({type: 'hello', version: 1});
    await waitFor('WebSocket handshake', () => messages.find(message => message.type === 'ready'));
    const subscriptionId = 'smoke-pty';
    send({type: 'subscribe', subscriptionId, topic: 'terminal', scope: {projectId, taskId: null, terminalId: terminal.id}});
    const state = await waitFor('PTY state', () => messages.find(message => message.type === 'event' && message.name === 'terminal.state'));
    assert.ok(state.type === 'event' && state.name === 'terminal.state' && state.data.owner);
    send({
      type: 'terminal.input', subscriptionId, generation: state.data.generation,
      // Split the marker so terminal echo alone cannot satisfy the assertion.
      data: "printf '\\nBENI_'; printf 'PTY_PID:%s\\n' \"$$\"\n",
    });
    const pid = await waitFor('PTY command output', () => {
      const output = messages.flatMap(message => message.type === 'event' && message.name === 'terminal.output' ? [message.data.data] : []).join('');
      const match = output.match(/BENI_PTY_PID:(\d+)\r?\n/);
      if (match) return Number(match[1]);
    });
    onPid(pid);
    assert.ok(processExists(pid), 'PTY shell exited before shutdown');
  } finally {
    socket.close();
  }
}

const [input, ...extra] = process.argv.slice(2);
assert.ok(input && extra.length === 0, 'Usage: bun scripts/test-exe.ts path/to/beni');
const artifact = resolve(input);
const bun = await realpath(process.execPath);
const temp = await realpath(await mkdtemp(join(tmpdir(), 'beni-exe-smoke-')));
const cwd = join(temp, 'cwd');
const restartCwd = join(temp, 'restart-cwd');
const home = join(temp, 'home');
const data = join(home, 'Library', 'Application Support', 'Beni', 'data');
const projectFolder = join(temp, 'project');
const path = join(temp, 'path');
const fixtures = join(temp, 'fixtures');
const first = join(temp, 'first', 'beni');
const second = join(temp, 'second', 'beni');
const env = {
  PATH: path, HOME: home, SHELL: '/bin/sh', TMPDIR: temp,
  BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0', BENI_PORT: '0',
};

let server: Subprocess | undefined;
let terminalPid: number | undefined;
let sqlPid: number | undefined;
try {
  const dirs = [cwd, restartCwd, home, projectFolder, path, fixtures, join(temp, 'first'), join(temp, 'second')];
  await Promise.all(dirs.map(dir => mkdir(dir)));
  for (const binary of [first, second]) {
    await copyFile(artifact, binary);
    await chmod(binary, 0o700);
  }

  const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
  for (const agent of ['codex', 'claude']) {
    const filename = `fake-${agent}.ts`;
    const fixture = join(fixtures, filename);
    await copyFile(join(import.meta.dir, '../src/backend/test', filename), fixture);
    await writeFile(join(path, agent), `#!/bin/sh\nexec ${shellQuote(bun)} ${shellQuote(fixture)} "$@"\n`, {mode: 0o700});
  }

  async function invoke(args: string[]) {
    const child = Bun.spawn([first, ...args], {
      cwd, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
      timeout: deadline, killSignal: 'SIGKILL',
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    return {code, stdout, stderr};
  }

  const tempEntries = (await readdir(temp)).sort();
  async function checkNoData() {
    assert.deepEqual((await readdir(temp)).sort(), tempEntries);
    assert.deepEqual(await readdir(cwd), []);
    assert.deepEqual(await readdir(home), []);
    assert.deepEqual(await readdir(join(temp, 'first')), ['beni']);
  }
  for (const flag of ['--version', '--help']) {
    const result = await invoke([flag]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /beni/i, flag);
    await checkNoData();
  }
  let origin: string;
  async function start(binary: string, workingDirectory: string, dataOverride?: string) {
    const childEnv = dataOverride === undefined ? env : {...env, BENI_DATA_DIR: dataOverride};
    const child = Bun.spawn([binary], {cwd: workingDirectory, env: childEnv, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe'});
    server = child;
    const output = {stdout: '', stderr: ''};
    const collect = async (stream: ReadableStream<Uint8Array>, key: keyof typeof output) => {
      const decoder = new TextDecoder();
      for await (const chunk of stream) output[key] += decoder.decode(chunk, {stream: true});
      output[key] += decoder.decode();
    };
    void collect(child.stdout, 'stdout');
    void collect(child.stderr, 'stderr');
    origin = await waitFor('server startup', () => {
      assert.equal(child.exitCode, null, output.stdout + output.stderr);
      return output.stdout.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
    });
  }

  async function json<T>(endpoint: string, status = 200, body?: object): Promise<T> {
    const request = body === undefined ? {} : {
      method: 'POST', headers: {origin, 'content-type': 'application/json'}, body: JSON.stringify(body),
    };
    const response = await fetch(origin + endpoint, {...request, signal: AbortSignal.timeout(deadline)});
    const payload = await response.text();
    assert.equal(response.status, status, `${endpoint}: ${payload.slice(0, 500)}`);
    return JSON.parse(payload) as T;
  }

  await start(first, cwd);
  assert.ok((await readdir(data)).includes('beni.sqlite'));
  await checkAssets(origin!);
  const project = await json<NamedRecord>('/api/projects', 201, {name: 'Smoke project', folder: projectFolder});
  const task = await json<NamedRecord>('/api/tasks', 201, {name: 'Smoke task', projectId: project.id});
  const scope = {projectId: project.id, taskId: task.id, phase: 'requirements'};
  const chatEndpoint = '/api/chat?' + new URLSearchParams(scope);
  const turns = [{provider: 'codex', model: null}, {provider: 'claude', model: 'haiku'}];
  let conversation: Conversation | undefined;
  for (const turn of turns) {
    const content = `Executable smoke test with ${turn.provider}`;
    const priorMessages = conversation?.messages.length ?? 0;
    await json('/api/chat/send', 202, {...scope, ...turn, content});
    conversation = await waitFor(`fake ${turn.provider} turn`, async () => {
      const chat = await json<Conversation>(chatEndpoint);
      if (chat.messages.length <= priorMessages) return;
      const reply = chat.messages.at(-1);
      assert.notEqual(reply?.status, 'failed', JSON.stringify(reply));
      if (reply?.role === 'assistant' && reply.status === 'completed') return chat;
    });
    assert.deepEqual(conversation.messages.slice(priorMessages).map(message => [message.role, message.content]), [
      ['user', content], ['assistant', 'Hello'],
    ]);
  }
  assert.ok(conversation);

  const sqlEndpoint = '/api/data/sql';
  const catalog = await json<DataSqlCatalog>(sqlEndpoint);
  assert.ok(catalog.tables.some(table => table.name === 'projects'));
  async function query(sql: string, database = 'app') {
    return json<DataSqlResult>(sqlEndpoint, 200, {database, sql});
  }
  assert.deepEqual((await query('SELECT name FROM projects')).rows, [[project.name]]);
  assert.deepEqual((await query('SELECT name FROM tasks', project.id)).rows, [[task.name]]);

  const slowQuery = 'WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n) SELECT count(i) FROM n';
  const timedOut = json<{error: string}>(sqlEndpoint, 408, {database: 'app', sql: slowQuery});
  // Capture rejection immediately while checking the child's process identity.
  void timedOut.catch(() => {});
  sqlPid = await waitFor('compiled SQL subprocess', () => sqlChild(server!.pid, first));
  assert.match((await timedOut).error, /時間切れ/);
  assert.ok(!processExists(sqlPid), 'Timed-out SQL subprocess is still running');
  sqlPid = undefined;
  const queries = await Promise.all([query('SELECT 1'), query('SELECT 2')]);
  assert.deepEqual(queries.map(result => result.rows), [[[1]], [[2]]]);

  const terminal = await json<TerminalSession>('/api/terminals', 201, {projectId: project.id, requestId: 'smoke-pty'});
  await checkTerminal(origin!, project.id, terminal, pid => { terminalPid = pid; });
  await stop(server!);
  server = undefined;
  assert.ok(terminalPid !== undefined && !processExists(terminalPid), 'PTY shell survived shutdown');
  terminalPid = undefined;

  await rm(first);
  await start(second, restartCwd);
  assert.deepEqual(await readdir(cwd), []);
  assert.deepEqual(await readdir(restartCwd), []);
  const persisted = await json<{projects: NamedRecord[]; tasks: NamedRecord[]}>('/api/state');
  assert.ok(persisted.projects.some(record => record.id === project.id && record.name === project.name));
  assert.ok(persisted.tasks.some(record => record.id === task.id && record.name === task.name));
  const restored = await json<Conversation>(chatEndpoint);
  assert.equal(restored.id, conversation.id);
  assert.deepEqual(restored.messages, conversation.messages);
  await stop(server!);
  server = undefined;

  const override = 'override-data';
  await start(second, restartCwd, override);
  const isolated = await json<{projects: NamedRecord[]; tasks: NamedRecord[]}>('/api/state');
  assert.deepEqual(isolated.projects, []);
  assert.deepEqual(isolated.tasks, []);
  assert.ok((await readdir(join(restartCwd, override))).includes('beni.sqlite'));
  await stop(server!);
  server = undefined;
  console.log('Executable smoke test passed');
} finally {
  try {
    if (server && server.exitCode === null && server.signalCode === null) await stop(server);
  } finally {
    try {
      for (const pid of [terminalPid, sqlPid]) {
        if (!pid) continue;
        try {
          process.kill(pid, 'SIGKILL');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
      }
    } finally {
      await rm(temp, {recursive: true, force: true});
    }
  }
}
