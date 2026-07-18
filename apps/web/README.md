# Luopan Web

The production dashboard is authored from `apps/web/src/main.ts` and served by
`luopan-api-rs` from `web/static`.

The committed `web/static/app.js` remains the runtime artifact so Docker builds
do not need Node.js. When changing frontend behavior, update `src/main.ts` and
rebuild the static asset:

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
- `web/static/style.css`
