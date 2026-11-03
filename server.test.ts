import { test, expect } from 'bun:test';
import { Store } from './store/index';
import { createHandler } from './server';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('project, task, chat and initial document flow', async () => {
 const store = new Store(':memory:'); const handle = createHandler(store);
 const post = (path: string, data: unknown) => handle(new Request(`http://127.0.0.1:3210${path}`,{method:'POST',headers:{origin:'http://127.0.0.1:3210','content-type':'application/json'},body:JSON.stringify(data)}));
 try {
  const p=await post('/api/projects',{name:'Example',folder:'/tmp/example'});expect(p.status).toBe(201);const project=await p.json();
  const t=await post('/api/tasks',{projectId:project.id,name:'Sample'});expect(t.status).toBe(201);const task=await t.json();
  expect((await post(`/api/tasks/${task.id}/messages`,{content:'  原文\n'})).status).toBe(201);
  const detail=await (await handle(new Request(`http://127.0.0.1:3210/api/tasks/${task.id}`))).json();
  expect(detail.messages[0].content).toBe('  原文\n');expect(detail.documents[0].content).toBe('# Sample\n');
  expect((await handle(new Request('http://127.0.0.1:3210/api/tasks',{method:'POST',headers:{origin:'https://example.com','content-type':'application/json'},body:'{}'}))).status).toBe(403);
  expect((await handle(new Request('http://example.com/api/state'))).status).toBe(403);
  expect((await post('/api/projects',{name:'x'.repeat(70000),folder:'/tmp/example'})).status).toBe(413);
 } finally {store.close()}
});

test('serves the compiled Solid app and locally generated stylesheet', async () => {
 const store = new Store(':memory:');
 try {
  const handle = createHandler(store);
  const page = await handle(new Request('http://127.0.0.1:3210/'));
  expect(await page.text()).toContain('/ui/build/app.js');
  const js = await handle(new Request('http://127.0.0.1:3210/ui/build/app.js'));
  expect(js.status).toBe(200);
  expect((await js.text()).length).toBeGreaterThan(1000);
  const css = await handle(new Request('http://127.0.0.1:3210/ui/generated.css'));
  expect(css.status).toBe(200);
  expect(await css.text()).toContain('.btn-primary');
 } finally { store.close(); }
});

test('folder picker lists direct real folders, resolves paths safely and rejects cross-origin or invalid input', async () => {
 const root = await mkdtemp(join(tmpdir(), 'beni-picker-test-'));
 const store = new Store(':memory:');
 try {
  const canonicalRoot = await realpath(root);
  await mkdir(join(root, 'beta'));
  await mkdir(join(root, 'alpha'));
  await mkdir(join(root, 'alpha', 'nested'));
  await writeFile(join(root, 'private.txt'), 'contents should not be returned');
  await symlink(join(root, 'alpha'), join(root, 'link'));
  const handle = createHandler(store, root);
  const post = (data: unknown, origin = 'http://127.0.0.1:3210') => handle(new Request('http://127.0.0.1:3210/api/folders/list', {
   method:'POST', headers:{origin,'content-type':'application/json'}, body:JSON.stringify(data),
  }));
  const initial = await post({});
  expect(initial.status).toBe(200);
  const result = await initial.json();
  expect(result.path).toBe(canonicalRoot);
  expect(result.directories).toEqual([
   {name:'alpha',path:join(canonicalRoot,'alpha')},
   {name:'beta',path:join(canonicalRoot,'beta')},
  ]);
  expect(result.truncated).toBe(false);
  expect(JSON.stringify(result)).not.toContain('private.txt');
  expect(JSON.stringify(result)).not.toContain('nested');
  const linked = await (await post({path:join(root, 'link')})).json();
  expect(linked.path).toBe(join(canonicalRoot,'alpha'));
  expect(linked.directories).toEqual([{name:'nested',path:join(canonicalRoot,'alpha','nested')}]);
  expect(linked.parent).toBe(canonicalRoot);
  expect((await post({}, 'https://example.com')).status).toBe(403);
  for (const path of ['', 'relative', null, 0, join(root, 'private.txt'), join(root, 'not-present')]) {
   const response = await post({path});
   expect(response.status).toBe(400);
   expect(await response.text()).not.toContain(root);
  }
 } finally { store.close(); await rm(root,{recursive:true,force:true}); }
});

test('folder picker bounds a directory listing', async () => {
 const root = await mkdtemp(join(tmpdir(), 'beni-picker-limit-test-'));
 const store = new Store(':memory:');
 try {
  await Promise.all(Array.from({length:501}, (_, index) => mkdir(join(root, `dir-${index}`))));
  const handle = createHandler(store, root);
  const response = await handle(new Request('http://127.0.0.1:3210/api/folders/list', {
   method:'POST', headers:{origin:'http://127.0.0.1:3210','content-type':'application/json'}, body:'{}',
  }));
  const result = await response.json();
  expect(response.status).toBe(200);
  expect(result.directories.length).toBe(500);
  expect(result.truncated).toBe(true);
 } finally { store.close(); await rm(root,{recursive:true,force:true}); }
});
