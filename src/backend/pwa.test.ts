import { expect, test } from 'bun:test';
import { createHandler } from './server';
import { Store } from './store/index';

const loopbackOrigin = 'http://127.0.0.1:3210';
const publicOrigin = 'https://beni.example.test';

for (const origin of [loopbackOrigin, publicOrigin]) {
  test(`serves installable PWA assets at ${origin}`, async () => {
    const store = new Store(':memory:');
    try {
      const handle = createHandler(store, undefined, undefined, origin === publicOrigin ? publicOrigin : undefined);
      const get = (path: string) => handle(new Request(origin + path));

      async function asset(path: string, contentType: string) {
        const response = await get(path);
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toBe(contentType);
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(response.headers.get('x-content-type-options')).toBe('nosniff');
        expect(response.headers.get('content-security-policy')).toContain("default-src 'self'");
        return response;
      }

      const html = await (await asset('/', 'text/html;charset=utf-8')).text();
      expect(html).toContain('rel="manifest" href="/manifest.webmanifest"');
      expect(html).toContain('rel="icon" type="image/png" sizes="192x192" href="/icons/icon-192.png"');
      expect(html).toContain('rel="apple-touch-icon" sizes="180x180" href="/icons/apple-touch-icon.png"');
      expect(html).toContain('name="theme-color" content="#e1e6d9"');

      const manifest = await (await asset('/manifest.webmanifest', 'application/manifest+json')).json();
      expect(manifest).toMatchObject({
        name: 'Beni',
        short_name: 'Beni',
        id: '/',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        lang: 'ja',
        theme_color: '#e1e6d9',
        background_color: '#e1e6d9',
        icons: [
          {src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png'},
          {src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png'},
        ],
      });

      const pngs = [
        ['/icons/icon-192.png', 192],
        ['/icons/icon-512.png', 512],
        ['/icons/apple-touch-icon.png', 180],
      ] as const;
      for (const [path, size] of pngs) {
        const bytes = Buffer.from(await (await asset(path, 'image/png')).arrayBuffer());
        expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
        expect(bytes.toString('ascii', 12, 16)).toBe('IHDR');
        expect(bytes.readUInt32BE(16)).toBe(size);
        expect(bytes.readUInt32BE(20)).toBe(size);
      }
      expect((await get('/icons/other.png')).status).toBe(404);
    } finally {
      store.close();
    }
  });
}
