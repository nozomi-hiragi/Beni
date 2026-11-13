// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@solidjs/testing-library';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Pack } from '../../shared/communication';
import ChatPanel from '../shared/components/ChatPanel';
import { resetModelCache } from '../shared/model-cache';
import { FakeWebSocket, packHeader, stubLegacyAgentFetch, testPack } from './test-events';

beforeEach(() => {
  resetModelCache();
  localStorage.clear();
  FakeWebSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    disconnect() {}
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderChat(projectId: string, packs: Pack[]) {
  stubLegacyAgentFetch(path => {
    if (path.startsWith('/api/chat?')) return Response.json({ id: 'conversation-1', messages: [] });
    if (path.startsWith('/api/chat/packs?')) {
      const after = new URL(path, 'http://localhost').searchParams.get('afterPackId');
      const remaining = packs.slice(packs.findIndex(pack => pack.packId === after) + 1);
      return Response.json({ packs: remaining.map(({ packId, state }) => ({ packId, state })) });
    }
    if (path.startsWith('/api/chat/packs/')) {
      return Response.json({ pack: packs.find(pack => path.includes(`/packs/${pack.packId}?`)) });
    }
    return Response.json({ installed: false, auth: 'none', models: [] });
  });
  render(() => <ChatPanel projectId={projectId} readOnly />);
}

it('renders and sanitizes saved assistant Markdown while preserving literal user and tool text', async () => {
  const markdown = [
    '# Saved answer',
    '',
    '- **First item**',
    '',
    '| Column |',
    '| --- |',
    '| Cell |',
    '',
    '```ts',
    'const example = 1;',
    '```',
    '',
    '[Example](https://example.com/) [Unsafe](javascript:alert(1))',
    '',
    '<p onclick="alert(1)">HTML paragraph</p>',
  ].join('\n');
  const userText = '# User request\n**Literal emphasis**';
  const input = '<strong>Tool input</strong>';
  const output = '**Tool output**';
  renderChat('019a0000-0000-7000-8000-00000000002c', [
    testPack(userText, { packId: 'user-pack', role: 'user' }),
    testPack(markdown, { packId: 'assistant-pack', sequence: 2 }),
    testPack('', { packId: 'tool-pack', sequence: 3, kind: 'tool', tool: { name: 'test_tool', input, output } }),
  ]);

  const heading = await screen.findByRole('heading', { name: 'Saved answer' });
  const bubble = heading.closest<HTMLElement>('.chat-bubble')!;
  expect(bubble.querySelector('li strong')?.textContent).toBe('First item');
  expect(within(bubble).getByRole('cell', { name: 'Cell' })).toBeTruthy();
  expect(bubble.querySelector('pre code')?.textContent).toBe('const example = 1;\n');
  expect(within(bubble).getByRole('link', { name: 'Example' }).getAttribute('href')).toBe('https://example.com/');
  expect(within(bubble).getByText('Unsafe').hasAttribute('href')).toBe(false);
  expect(within(bubble).getByText('HTML paragraph').hasAttribute('onclick')).toBe(false);

  expect(screen.getByText('# User request **Literal emphasis**').textContent).toBe(userText);
  const tool = (await screen.findByText('test_tool')).closest('details')!;
  expect(Array.from(tool.querySelectorAll('pre'), node => node.textContent)).toEqual([input, output]);
  expect(tool.querySelector('strong')).toBeNull();
});

it('updates Markdown from streaming deltas in the existing chat article', async () => {
  renderChat('019a0000-0000-7000-8000-00000000002d', [testPack('Earlier reply')]);
  await screen.findByText('Earlier reply');
  const socket = FakeWebSocket.instances[0];
  await waitFor(() => expect(socket.subscriptions.size).toBe(1));

  const pack = testPack('', { packId: 'streaming', sequence: 2, state: 'streaming', status: 'streaming' });
  const header = packHeader(pack);
  socket.event('chat', { name: 'chat.pack.delta', data: { packId: pack.packId, delta: '## Streaming reply\n\n- **First', header } });
  const heading = await screen.findByRole('heading', { name: 'Streaming reply' });
  const article = heading.closest('article')!;
  expect(article.querySelector('li')?.textContent).toBe('**First');

  socket.event('chat', { name: 'chat.pack.delta', data: { packId: pack.packId, delta: ' item**', header } });
  expect(screen.getByRole('heading', { name: 'Streaming reply' }).closest('article')).toBe(article);
  expect(article.querySelector('li strong')?.textContent).toBe('First item');
});
