import { JSDOM, VirtualConsole } from 'jsdom';
import { populateGlobal } from 'vitest/runtime';

/** @type {import('vitest/runtime').Environment} */
export default {
  name: 'jsdom',
  viteEnvironment: 'client',
  setup(global) {
    // Vitest enables script execution in its jsdom environment. That creates a
    // node:vm context whose window fails jsdom's EventTarget checks under Bun.
    const virtualConsole = new VirtualConsole();
    virtualConsole.on('jsdomError', error => {
      if (error.type === 'unhandled-exception') process.emit('uncaughtException', error.cause);
    });
    const { window } = new JSDOM('', { url: 'http://localhost:3000', pretendToBeVisual: true, virtualConsole });
    const { keys, originals } = populateGlobal(global, window, { bindFunctions: true });
    return {
      teardown() {
        window.close();
        for (const key of keys) delete global[key];
        for (const [key, descriptor] of originals) Object.defineProperty(global, key, descriptor);
      },
    };
  },
};
