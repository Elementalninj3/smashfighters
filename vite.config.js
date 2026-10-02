import { defineConfig } from 'vite';
import { cpSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Media served with Cache-Control: no-store so the browser never caches or
// revalidates them. Prevents net::ERR_CACHE_READ_FAILURE (corrupted HTTP-cache
// reads) that vite's default "no-cache" + ETag responses trigger in dev.
// Font files are in the list for the same reason: the self-hosted Milker face is
// fetched by the browser exactly like an <audio> element, so it hits the very
// same corrupted-cache path. sirv preserves an already-set Cache-Control header,
// so this pre-middleware reliably wins over its default.
const NO_STORE_MEDIA_RE = /\.(mp3|wav|ogg|m4a|aac|flac|png|jpe?g|webp|gif|webm|mp4|otf|woff2?|ttf|eot)$/i;

function noStoreMedia() {
  return {
    name: 'no-store-media',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url && NO_STORE_MEDIA_RE.test(req.url)) {
          res.setHeader('Cache-Control', 'no-store');
        }
        next();
      });
    },
    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url && NO_STORE_MEDIA_RE.test(req.url)) {
          res.setHeader('Cache-Control', 'no-store');
        }
        next();
      });
    },
  };
}

// Serves the project's own asset library under /GA (the game reads skins and
// accessory art straight from game/GA/*. This keeps user-authored characters
// out of public/ while still working in dev + production builds.
function gaAssets() {
  return {
    name: 'ga-assets',
    closeBundle() {
      const ga = resolve(process.cwd(), 'GA');
      if (!existsSync(ga)) return;
      cpSync(ga, resolve(process.cwd(), 'dist', 'GA'), { recursive: true });
    },
  };
}

export default defineConfig({
  plugins: [noStoreMedia(), gaAssets()],
  server: {
    host: 'localhost',
    port: 5173,
    strictPort: true,
    hmr: {
      host: 'localhost',
      port: 5173,
      protocol: 'ws',
    },
  },
});
