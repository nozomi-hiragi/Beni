const html = {
  path: 'src/frontend/index.html',
  type: 'text/html;charset=utf-8',
};

const assets = new Map([
  ['/ui/build/app.js', {path: 'dist/frontend/app.js', type: 'text/javascript;charset=utf-8'}],
  ['/ui/style.css', {path: 'dist/frontend/beni.css', type: 'text/css;charset=utf-8'}],
  ['/ui/generated.css', {path: 'dist/frontend/generated.css', type: 'text/css;charset=utf-8'}],
  ['/manifest.webmanifest', {path: 'src/frontend/pwa/manifest.webmanifest', type: 'application/manifest+json'}],
  ['/icons/icon-192.png', {path: 'src/frontend/pwa/icons/icon-192.png', type: 'image/png'}],
  ['/icons/icon-512.png', {path: 'src/frontend/pwa/icons/icon-512.png', type: 'image/png'}],
  ['/icons/apple-touch-icon.png', {path: 'src/frontend/pwa/icons/apple-touch-icon.png', type: 'image/png'}],
]);

const assetRoot = new URL('../../', import.meta.url);
declare const BENI_EMBEDDED_FRONTEND: Record<string, string> | undefined;

export const frontendAssetPaths = [html, ...assets.values()].map(({path}) => path);

export function isFrontendAsset(pathname: string): boolean {
  return pathname === '/ui/index.html' || assets.has(pathname);
}

export function frontendResponse(pathname: string) {
  const {path, type} = assets.get(pathname) ?? html;
  const body = typeof BENI_EMBEDDED_FRONTEND === 'undefined'
    ? Bun.file(new URL(path, assetRoot))
    : Buffer.from(BENI_EMBEDDED_FRONTEND[path], 'base64');
  return new Response(body, {
    headers: {
      'Content-Type': type,
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; style-src-elem 'self' 'unsafe-inline'; style-src-attr 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    },
  });
}
