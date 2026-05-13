# Deploying the AHC demo UI to Railway

Live demo target for course defense: a publicly reachable URL that runs
the Next.js UI (`src/ui/`) gated by a shared password.

## Plan account

- **Plan:** Railway Hobby ($5/mo). Hobby allows up to 50 projects per
  workspace, so an existing pet project can coexist with `ahc-demo`.
- **No sleep policy** on Hobby — the container stays warm.
- **$5 included credits** are pooled across the workspace; overage is
  pay-as-you-go on Railway compute. The OpenRouter bill is **separate**
  and arrives on the OpenRouter key the demo runs under.

## Required secrets

| Env var | Where used | Notes |
|---|---|---|
| `OPENROUTER_API_KEY` | `src/ui/app/api/chat/route.ts` | Main LLM provider for the chat actor. |
| `GOOGLE_GENAI_API_KEY` | `src/ui/lib/googleGenai.ts` (via `create_image` tool) | Gemini image generation. |
| `DEMO_PASSWORD` | `src/ui/middleware.ts` | Shared HTTP Basic password. **If unset, middleware returns 503 on every request** — never deploys "open". |

Railway injects `PORT` at runtime; the start script (`pnpm start:ui`)
honours `${PORT:-3000}`. `NODE_ENV=production` is set inside the
`Dockerfile`, which enables the `secure` cookie flag in the auth
middleware.

## First deploy

Manual one-time setup. Run these from the repo root.

1. `! railway login` (interactive browser auth).
2. `! railway init` — pick the existing workspace, name the project
   `ahc-demo`.
3. `! railway up` — Railway streams the build context, builds via the
   repo's `Dockerfile`, and deploys.
4. **Set variables** in the Railway dashboard (project → Variables tab):
   - `OPENROUTER_API_KEY`
   - `GOOGLE_GENAI_API_KEY`
   - `DEMO_PASSWORD` — pick a strong shared secret (16+ chars).
5. **Generate public domain:** project → Settings → Networking →
   "Generate Domain". Copy the `*.up.railway.app` URL.
6. **Workspace usage cap:** Workspace settings → Usage Limits →
   set a monthly cap (suggestion: $4) so the existing pet project keeps
   headroom inside the $5 included credit.
7. **OpenRouter hard spend cap (separate dashboard):** at
   <https://openrouter.ai/keys>, on the key used here, set a monthly
   spend cap (suggestion: $5–10). The Railway cap protects compute
   only — it does not stop OpenRouter from billing for chat turns.

## Post-deploy smoke

1. Open the Railway URL in a fresh browser tab → expect a Basic auth
   prompt with realm "AHC Demo".
2. Submit `DEMO_PASSWORD` → expect the chat UI to load and a
   `ahc-demo-auth` cookie to be set (7-day expiry).
3. Three-turn smoke:
   - Plain text turn — verify a response comes back.
   - `fetch_url https://example.com` — verify the tool fires and the
     telemetry sidebar shows `compaction_event > 0` after the turn.
   - `create_image "cyberpunk cat"` — verify the image renders inline.
4. `curl https://<project>.up.railway.app/healthz` from a terminal
   (no auth header) → expect `200 ok`. This is the path Railway's
   own healthcheck hits; if it ever returns 401, the middleware
   matcher is misconfigured.

## Updating the deploy

- Code change → commit on `master` → `railway up` again (or enable
  GitHub auto-deploy in Railway settings).
- Secret rotation → update the Variables tab; Railway restarts the
  service.
- Rolling back → Railway dashboard → Deployments tab → click the prior
  deployment → "Redeploy".

## When something goes wrong

- **`/healthz` returns 401**: middleware matcher regex regression. Check
  that `src/ui/middleware.ts` `config.matcher` still excludes `healthz`.
- **App boots but every request 503s**: `DEMO_PASSWORD` is not set in
  the Variables tab. Set it and redeploy.
- **Container crash on boot with `Cannot find module`**: the Next
  standalone tracer missed a dynamic import. Reproduce locally with
  `docker build -t ahc-ui-test . && docker run --rm -p 3000:3000 …`
  and add an explicit `outputFileTracingIncludes` entry in
  `src/ui/next.config.js`.
- **OpenRouter 401s in chat**: the `OPENROUTER_API_KEY` set in Railway
  is missing or invalid — copy a fresh one from
  <https://openrouter.ai/keys>.

## Local Docker smoke (before pushing to Railway)

```sh
docker build -t ahc-ui-test .
docker run --rm -p 3000:3000 \
  -e OPENROUTER_API_KEY="$OPENROUTER_API_KEY" \
  -e GOOGLE_GENAI_API_KEY="$GOOGLE_GENAI_API_KEY" \
  -e DEMO_PASSWORD=test \
  ahc-ui-test
```

Open <http://localhost:3000> — same smoke as the post-deploy checklist
above, against the locally-built image. Cookie `secure` flag is off in
this case (`NODE_ENV` is set inside the image, but the smoke uses http
on localhost where the browser ignores `secure`).
