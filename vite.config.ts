import { defineConfig, type Plugin } from 'vite';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * Dev-only endpoint so the review pipeline can pull a render off the canvas and
 * onto disk. The gate scripts (diagnose_render, divine_eye, make_comparison_sheet)
 * all take file paths, and the browser cannot write files directly.
 * Writes are confined to <project>/build/renders.
 */
function saveRender(): Plugin {
  const ROOT = resolve(__dirname, 'build/renders');
  return {
    name: 'save-render',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__save', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          return res.end('POST only');
        }
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(c as Buffer));
        req.on('end', () => {
          try {
            const { name, dataUrl } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            const safe = String(name).replace(/[^a-zA-Z0-9._-]/g, '_');
            const out = resolve(ROOT, safe);
            if (!out.startsWith(ROOT)) throw new Error('path escape');
            mkdirSync(dirname(out), { recursive: true });
            writeFileSync(out, Buffer.from(String(dataUrl).split(',')[1], 'base64'));
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ ok: true, path: out }));
          } catch (err) {
            res.statusCode = 400;
            res.end(String(err));
          }
        });
      });
    },
  };
}

export default defineConfig({
  base: process.env.GITHUB_PAGES ? "/cz75-emerald-pistol/" : "/",
   plugins: [saveRender()] });
