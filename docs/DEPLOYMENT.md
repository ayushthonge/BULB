# Deployment Guide

End-to-end steps to run Socratic AI in production. Two parts: the **server**
(public HTTPS API) and the **VS Code extension** (distributed to students).

## 1. Provision a database

Create a Postgres database (Neon free tier is fine). Copy its connection string
(with `?sslmode=require`).

## 2. Configure the server

```bash
cd server
cp .env.example .env
# edit .env: set GEMINI_API_KEY and DATABASE_URL at minimum
npm install
```

Apply the schema (idempotent — safe to re-run):

```bash
npm run migrate
```

Run locally to verify:

```bash
npm run dev
curl http://localhost:3000/health     # -> {"status":"healthy","db":"connected",...}
npm test                              # 32 unit tests for guards/resolution/model
```

## 3. Create student tokens

```bash
# one email per line in students.csv
npm run -s build >/dev/null 2>&1 || true
ts-node src/scripts/generate-student-tokens.ts students.csv > tokens.csv
```

Distribute each student their token; they set it via the extension command
**“Socratic: Set Auth Token.”** Add an admin with the `/admin/whitelist/add`
endpoint (role `admin`) to reach `/admin/analytics`.

## 4. Deploy the server

The server is stateless apart from a best-effort in-memory cache backed by
Postgres, so any container host works. A `Dockerfile` and a Render blueprint are
included.

### Option A — Render (blueprint)

1. Push this repo to GitHub.
2. In Render: **New → Blueprint**, point at the repo (`render.yaml`).
3. Set `GEMINI_API_KEY` and `DATABASE_URL` (marked `sync:false`) in the dashboard.
4. Deploy. `preDeployCommand` runs migrations; `/health` is the health check.

### Option B — Docker anywhere (Fly.io, Railway, a VM…)

```bash
cd server
docker build -t socratic-ai-server .
docker run -p 3000:3000 \
  -e NODE_ENV=production \
  -e GEMINI_API_KEY=... \
  -e DATABASE_URL=... \
  socratic-ai-server
# migrations (once per schema change), against the same DATABASE_URL:
docker run --rm -e DATABASE_URL=... socratic-ai-server node dist/scripts/migrate.js
```

In production (`NODE_ENV=production`) the server **fails fast** if
`GEMINI_API_KEY` / `DATABASE_URL` are missing and never returns stack traces to
clients.

## 5. Point the extension at the server

The extension reads `socratic.serverUrl` (default `http://localhost:3000`).
Students set it in VS Code settings, or ship a packaged build with the default
changed to your deployed URL. Note the webview CSP `connect-src` in
`extension/src/SidebarProvider.ts` already allows the configured server URL.

## 6. Package the extension

```bash
cd extension
npm install
npm run package           # webpack production build -> dist/
npx @vscode/vsce package  # -> socratic-ai-extension-x.y.z.vsix
```

Share the `.vsix` (Extensions view → “Install from VSIX…”) or publish to the
Marketplace.

## 7. Collect research data

```bash
cd server
npm run export-analytics ./export
#   export/analytics-summary.json   aggregate dashboard (incl. RQ3 recurrence)
#   export/query-summaries.jsonl    per-query misconception trajectories
#   export/turns.csv                per-turn rows for discourse/artifact analysis
```

Or hit `GET /admin/analytics` with an admin token for the live dashboard.

## Rollback

This work lives entirely on the `socratic-production-hardening` branch. To
return to the pre-hardening state: `git checkout baseline-pre-hardening` (tag)
or `git checkout ayush` (the original branch, untouched).
