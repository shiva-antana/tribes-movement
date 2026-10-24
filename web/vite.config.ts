import { defineConfig, type Plugin } from 'vite';
import { resolve, join, normalize } from 'node:path';
import { existsSync, readFileSync, rmSync } from 'node:fs';

/**
 * Local-only reference assets (original Tribes meshes/textures from `npm run tribes`) live in
 * web/reference/, outside public/, so they are served by the dev server at /local-reference/ and
 * can never end up in a production build. public/reference/ (drop-in references) is stripped from dist too.
 */
function localReference(): Plugin {
  const root = resolve(__dirname, 'reference');
  const types: Record<string, string> = { glb: 'model/gltf-binary', json: 'application/json', png: 'image/png' };
  return {
    name: 'local-reference',
    configureServer(server) {
      server.middlewares.use('/local-reference', (req, res, next) => {
        const file = normalize(join(root, decodeURIComponent((req.url ?? '').split('?')[0])));
        if (!file.startsWith(root) || !existsSync(file)) return next();
        res.setHeader('Content-Type', types[file.split('.').pop()!] ?? 'application/octet-stream');
        res.end(readFileSync(file));
      });
    },
    closeBundle() { rmSync(resolve(__dirname, 'dist', 'reference'), { recursive: true, force: true }); },
  };
}

export default defineConfig({
  plugins: [localReference()],
  build: {
    rollupOptions: {
      input: { main: resolve(__dirname, 'index.html'), workbench: resolve(__dirname, 'workbench.html') },
    },
  },
});
