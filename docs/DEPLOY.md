# Deploy

G1 ships deployable artifacts for the hosted, always-on Next standalone server. Remote deployment
is deferred; build and run the same image on Fly, Render, Railway, a VPS, or any Docker host.

## Build and Run

```bash
docker build -t meta-manager .
docker run --rm -p 3000:3000 \
  --env-file .env \
  -e HOSTED=1 \
  meta-manager
```

Or run the always-on app stack locally with its dedicated compose file:

```bash
docker compose -f docker-compose.app.yml up --build
```

(`docker-compose.yml` is reserved for the local **dev Postgres** — see `docs/LIVE_TESTING.md`.) The
app container starts from `.next/standalone` with `node server.js`. `HOSTED=1` disables the in-app
`.env` editor; use host-provided secrets instead. `DATABASE_URL` in `.env` must be reachable from
the container (Neon, or the dev Postgres via `host.docker.internal`).

## Required Host Secrets

Set these in the host secret store or process environment. Never commit a secrets file.

| Var | Purpose |
| --- | --- |
| `DATABASE_URL` | Runtime Postgres connection string. Local Postgres or Neon TCP both work. |
| `OPERATOR_USERNAME`, `OPERATOR_PASSWORD` | Required single-operator login credential. |
| `SESSION_SECRET` | Required long random string used to sign session cookies. |
| `META_SYSTEM_USER_TOKEN` | Agency System User token used by server-side Meta calls. |
| `META_APP_ID`, `META_APP_SECRET` | Meta app credentials for setup/verification flows. |
| `META_API_VERSION` | Optional; defaults to `v23.0`. |
| `BLOB_READ_WRITE_TOKEN` | Required only if creative uploads use Vercel Blob. |
| `AI_GATEWAY_API_KEY`, `COPY_MODEL` | Required only if AI copy generation is used. |
| `WRITE_MODE` | Autonomy write gate: `off`, `observe`, `tier_a`, or `all`. |
| `DISABLE_SCHEDULER` | Set `1` for a web-only second instance with no scheduler. |

`HOSTED=1` should be set for hosted containers so secrets are read from the host environment and
the writable `.env` path stays local-dev/desktop only.

## Migrations

Apply the schema before (or on) first boot — the server seeds the bootstrap operator/client at
startup and will error against an unmigrated database:

```bash
DATABASE_URL=... npm run db:migrate
```

## Runtime Notes

The hosted Node server is now the production runtime that carries automation. `src/instrumentation.ts`
starts the scheduler once per Node server instance unless `DISABLE_SCHEDULER=1`.

Electron remains available as an optional local development shell:

```bash
npm run desktop
npm run desktop:prod
```
