import { createAppHandler } from './runtime';

if (import.meta.main) {
  const app = createAppHandler(process.env.BENI_DB ?? 'beni.sqlite');
  try {
    const server = Bun.serve({ hostname: '127.0.0.1', port: Number(process.env.BENI_PORT ?? 3210), maxRequestBodySize: 65536, fetch: app.fetch });
    console.log(`Beni: http://127.0.0.1:${server.port}/`);
  } catch (error) { app.close(); throw error; }
}
