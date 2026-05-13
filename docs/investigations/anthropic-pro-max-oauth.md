# Investigation: Anthropic Pro/Max OAuth auth for C2 baseline

## Meta

- **Date Created:** 2026-05-13
- **Date Updated:** 2026-05-13
- **Status:** Completed (with one deferred validation)
- **Related:** decisions.md 2026-05-13 (C2 vendor-exception); design/C_baselines.md §3;
  src/eval/baselines/anthropic_compact.ts; src/eval/runner.ts §makeAnthropicCompactRunner.

## Goal

Понять, можно ли биллить C2-бейзлайн через Pro/Max-подписку (Claude.ai-аккаунт) вместо
API-credits c console.anthropic.com — **без замены SDK или смены семантики бейзлайна**
(C2 продолжает измерять server-side `compact_20260112`, а не agentic-loop из
`claude-agent-sdk`).

## Problem Statement

- C2 в первоначальном виде требовал `ANTHROPIC_API_KEY` (console credits).
- У пользователя есть Pro/Max-подписка и желание использовать её для интеграционных
  прогонов — экономичнее и не нужно отдельно покупать API tier.
- Сосед-проект (`~/Projects/ai_scientists/Holosophus`) использует Claude Agent SDK
  через `CLAUDE_CODE_OAUTH_TOKEN` (long-lived, выдаётся `claude setup-token`),
  биллится через подписку. Но Holosophus использует HIGH-LEVEL agent SDK,
  абстрагирующий context_management — не то, что нам надо для C2.

## Scope

- **In scope:** auth-механика `@anthropic-ai/sdk` (low-level), env-resolver в
  runner.ts, документация.
- **Out of scope:** Замена C2 на `@anthropic-ai/claude-agent-sdk` (другой бейзлайн,
  другая семантика — пометили как `system_design.md §7.2` candidate, не эта PR).
- **Constraints:** Не менять what C2 measures (compact_20260112). Не вводить отдельный
  OAuth flow в repo — пользователь генерит токен вручную через CLI.

## Hypotheses

| ID | Hypothesis | Why plausible | How to validate | Status |
|---|---|---|---|---|
| H1 | `@anthropic-ai/sdk` принимает Bearer-токен наряду с API key (тот же тип auth, что Claude Code) | SDK универсальный; OAuth — общепринятая модель для Anthropic backend | grep node_modules/@anthropic-ai/sdk/client.* | confirmed |
| H2 | `CLAUDE_CODE_OAUTH_TOKEN` (формат `sk-ant-oat-…`) принимается тем же endpoint, что и при subscription-billing'е Claude Code | Claude Code сам бьёт по `api.anthropic.com` тем же транспортом | observation: identical Bearer header path in SDK | confirmed |
| H3 | beta-strategy `compact_20260112` доступна на subscription-tier (не gate'нута за API-tier) | feature server-side, не billing-feature; precedent: Claude Code сам собой компактится у Pro/Max-юзеров | live request → ожидаем 200 OK + BetaCompactionBlock на длинной истории | confirmed (auth + schema), но **subscription rate-limit делает route непрактичным** — см. Findings |
| H4 | LiteLLM-proxy (Anthropic-protocol `/v1/messages`) пропускает `anthropic-beta: compact-2026-01-12` header + `context_management` body без drop_params | LiteLLM работает на pass-through для unknown params если они в headers; body-проброс зависит от `drop_params` setting | curl probe против local proxy (jay-canvas/llm-proxy on :4400) | confirmed — response содержит `context_management.applied_edits: []` |

## Evidence

**Anthropic SDK (узловой код):**

```
node_modules/@anthropic-ai/sdk/client.d.ts:38
  authToken?: string | null | undefined;
node_modules/@anthropic-ai/sdk/client.d.ts:148
  authToken: string | null;
node_modules/@anthropic-ai/sdk/client.d.ts:177
  @param {string | null | undefined} [opts.authToken=process.env['ANTHROPIC_AUTH_TOKEN'] ?? null]
node_modules/@anthropic-ai/sdk/client.js:67
  constructor({ baseURL = ..., apiKey, authToken, webhookKey, ...opts } = {})
node_modules/@anthropic-ai/sdk/client.js:77
  authToken = ... readEnv('ANTHROPIC_AUTH_TOKEN') ?? null
node_modules/@anthropic-ai/sdk/client.js:334,348
  return buildHeaders([{ Authorization: `Bearer ${this.authToken}` }])
```

**Holosophus pattern (neighbour project):**

```
~/Projects/ai_scientists/Holosophus/.env_example:12-16
  # Claude Code CLI auth for run_research.py (Claude Agent SDK spawns the CLI).
  # Preferred: long-lived OAuth token tied to your Pro/Max subscription.
  # Get it via `claude setup-token` in a real terminal (needs TTY).
  CLAUDE_CODE_OAUTH_TOKEN=
```

Holosophus использует Python `claude-agent-sdk` (subprocess'ит CLI), не низкоуровневый SDK.
То есть OAuth-токен у них работает на уровне CLI, а CLI внутри использует тот же
Anthropic HTTP-endpoint. Мы используем тот же endpoint напрямую через
`@anthropic-ai/sdk` — токен должен работать симметрично.

## Findings

| Source | Result | Confidence | Notes |
|---|---|---|---|
| H1: SDK source | `authToken` опт принят с момент создания клиента, рендерится в `Authorization: Bearer` | high | code-level fact |
| H2: Format compatibility | `sk-ant-oat-*` принимается SDK как opaque Bearer-token | high | SDK не делает schema-проверку token'а |
| H3: compact_20260112 availability | feature accessible через OAuth — но subscription rate-limit (429 на 2-м запросе подряд) делает route непрактичным для programmatic sweep'ов | high | live-валидация через `CLAUDE_CODE_OAUTH_TOKEN`: схема + beta-header + body приняты до tier-limit'а; повторные попытки с задержкой не помогли |
| Beta header gotcha | Header value = `compact-2026-01-12` (dash-separated), НЕ `compact_20260112` (это strategy `type` inside `edits[]`) | high | live error: `Unexpected value(s) 'compact_20260112' for anthropic-beta` → найден правильный value через https://platform.claude.com/docs/en/build-with-claude/compaction |
| Trigger value floor | API enforces `trigger.value >= 50000`; values below 400-rejected | high | live error message; default bumped to 100000 (SDK's `DEFAULT_TOKEN_THRESHOLD`) |
| H4: LiteLLM pass-through | LiteLLM `/v1/messages` пропускает beta-header + context_management body без drop_params (на jay-canvas/llm-proxy config) | high | curl probe + 3-турн live test через runner passed end-to-end |
| LiteLLM model-name form | Proxy требует dot-form (`claude-sonnet-4.6`) — алиасит на upstream dash-form `anthropic/claude-sonnet-4-6`. Sending raw dash-form → 400 "Invalid model name" | high | live probe |

## Interpretation

- Гипотезы H1, H2 подтверждены: `@anthropic-ai/sdk` natively принимает OAuth-токен
  через `authToken` opt и поднимает его в Bearer-header.
- H3 не противоречит ничему наблюдаемому, но live-проверка требует Pro/Max токен
  пользователя; до того момента это допущение.
- **Альтернатива отвергнута:** перевод C2 на `claude-agent-sdk`. Эта SDK выполняет
  собственную auto-compaction (через CLI's `/compact` semantics), и мы потеряем
  контроль над raw `compact_20260112`-strategy → бейзлайн станет другим.
- **Альтернатива отвергнута:** новый dependency или OAuth-flow в repo. SDK уже
  поддерживает env-var path, генерация токена — однократная операция пользователя.

## Next Actions

- **Action 1 (done):** Расширить `AnthropicCompactDeps` до discriminated union
  `{apiKey} | {authToken}` + runtime guard (ни одного, либо оба).
  `src/eval/baselines/anthropic_compact.ts`.
- **Action 2 (done):** В `makeAnthropicCompactRunner()` resolve order
  `CLAUDE_CODE_OAUTH_TOKEN > ANTHROPIC_API_KEY`; error если ничего нет.
  `src/eval/runner.ts:110-130`. (Изначально rezolve-цепочка включала SDK-native
  `ANTHROPIC_AUTH_TOKEN` как primary, но naming унифицирован к одному
  CLI-friendly имени — токен идёт из `claude setup-token`, бессмысленно держать
  два env-имени для одного источника. SDK получает токен через explicit
  `authToken` opt, env-name SDK уже не важен.)
- **Action 3 (done — with inversion):** Подтвердить H3 — done. Auth + schema +
  beta header проходят, но Pro/Max subscription rate-limit (429 на втором
  запросе в течение минуты) делает OAuth-route непрактичным для sweep'ов.
  Решение: добавлен LiteLLM-route (см. Action 4); OAuth остаётся как валидный
  но deprecated path для one-off smoke validations.
- **Action 4 (done):** LiteLLM proxy routing — runner.ts:makeAnthropicCompactRunner
  reads `LITELLM_MASTER_KEY` + `LITELLM_BASE_URL`; если оба заданы — клиент
  идёт на `http://localhost:4400/v1/messages` (Anthropic-protocol),
  upstream-биллится corporate Anthropic key. Sweep `eval/sweeps/smoke_anthropic_compact.yaml`
  прогнан end-to-end через CLI, 2/2 tasks, 200 OK, токены captured.
- **Verification:**
  - Без токенов: `./scripts/verify.sh` зелёный, live tests skip-mark'ятся.
  - С `OPENROUTER_API_KEY`: OpenRouter-side live tests проходят (full_context,
    mastra_om).
  - С `LITELLM_MASTER_KEY` + `LITELLM_BASE_URL`: anthropic_compact live test
    + sweep CLI зелёные.
  - С `CLAUDE_CODE_OAUTH_TOKEN`: auth + schema validate, но rate-limit
    блокирует sweep'ы.
- **Decision entry:** см. `docs/decisions.md` запись `[2026-05-13] C2 dual auth`.
- **Harness entry:** не требуется (повторяющаяся ошибка не наблюдалась).
