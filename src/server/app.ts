// Hono app: static SPA hosting + /api routes.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import type { Deps } from './deps.js';
import { createApi } from './routes/api.js';

export function createApp(deps: Deps): Hono {
  const app = new Hono();

  app.route('/', createApi(deps));

  // Built SPA (vite build output). In dev, vite serves the frontend itself.
  const webDist = process.env.WEB_DIST ?? path.resolve(import.meta.dirname, '../web');
  if (existsSync(webDist)) {
    app.use(
      '*',
      serveStatic({
        root: path.relative(process.cwd(), webDist),
        rewriteRequestPath: (p) => p,
      }),
    );
    // SPA fallback for client-side routes.
    app.get('*', (c) => {
      const index = path.join(webDist, 'index.html');
      if (existsSync(index)) {
        return c.body(readFileSync(index, 'utf8'), 200, {
          'Content-Type': 'text/html; charset=utf-8',
        });
      }
      return c.text('frontend build missing', 404);
    });
  }

  return app;
}
