# Luopan Web

The production dashboard is authored in `apps/web/` (`index.html`, TypeScript,
and CSS) and served by `luopan-api-rs` from the generated `web/static` output.

The committed `web/static/app.js` remains the runtime artifact so Docker builds
do not need Node.js. When changing frontend behavior or styling, update files
under `apps/web/` and rebuild the static assets; never edit `web/static/`
directly:

```bash
cd apps/web
pnpm install
pnpm build
```

For local frontend iteration, start the Rust dashboard API on `127.0.0.1:8501`
and then start Vite:

```bash
pnpm dev
```

Vite serves `apps/web/index.html` and proxies `/api` plus `/assets` to
`luopan-api-rs`.

`luopan-api-rs` serves:

- `web/static/index.html`
- `web/static/app.js`
- `web/static/style.css` (generated from `apps/web/src/style.css`)
