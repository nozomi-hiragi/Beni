import { test, expect } from 'bun:test';
import { Store } from './store/index';
import { createHandler } from './server';

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
