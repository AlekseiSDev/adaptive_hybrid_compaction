# Investigation: OpenRouter prompt-cache passthrough для UI demo

## Meta

- **Date Created:** 2026-05-13
- **Date Updated:** 2026-05-13
- **Status:** Completed
- **Related:** `system_design.md §5.2` (cache rate metric), `system_design.md:91,246,293`
  (OpenRouter cache caveats), `decisions.md` (E0/E3 cache-hit subset on `anthropic_direct`),
  `docs/design/G_ui.md §G3` (telemetry sidebar shows `tokens.cache_read`),
  `src/ui/lib/ahcStats.ts:48`, `src/adapters/ahc-runtime.ts:120`.

## Goal

UI demo sidebar показывал `cache_read = 0` после нескольких turn'ов с тем же system
promtp'ом. Цель: понять — это (а) bug в нашем pipeline, (б) provider gap, или (в)
expected при выбранной конфигурации, и довести `cache_read` до видимого ненулевого
значения в demo.

## Problem Statement

- На скриншоте `[Image 2]` (2026-05-13 ~16:00) после 3 turn'ов с одинаковым stable
  prefix sidebar показывал `cache_read = 0`. Пользователь предположил баг.
- Затронутые компоненты: `route.ts:onFinish → buildAhcStats → TelemetrySidebar`.
- Это проблема потому, что G3 exit-criterion (`G_ui.md §G3`) требует видимого
  `tokens.cache_read` per turn — иначе demo не демонстрирует ключевую AHC ценность
  ("AHC cache-safe compaction → cache hit growth across turns").
- Уже известно (до probe): adapter-side AHC middleware **не трогает** result, и
  `cacheControlEnabled = (provider === 'anthropic_direct')` (`ahc-runtime.ts:120`) —
  для OpenRouter cache_control hint **не отправляется** (`ai-sdk-v6.ts:51-53` comment).
  `system_design.md:246` явно фиксирует "OpenRouter doesn't always expose cache headers".

## Scope

- **In scope:** UI demo path (`src/ui/app/api/chat/route.ts` + ahcStats + sidebar).
  Цепочка provider → AI SDK v6 → ahcStats → UI.
- **Out of scope:**
  - `src/eval/*` — параллельные E1 experiments (per session memory).
  - `src/core/*` и `src/adapters/*` — AHC pipeline уже tool/cache-агностичен; адаптерная
    cache-control логика уже корректна для `anthropic_direct`.
  - Cache invariance contract — отдельный inviarant покрыт `pnpm test:cache-invariance`.
- **Constraints:** не блокировать E1 sweep (не трогать eval pricing); demo budget — single
  user, лимиты OpenRouter free tier; нужно убедиться live, не только в тестах.

## Hypotheses

| ID | Hypothesis | Why plausible | How to validate | Status |
|---|---|---|---|---|
| H1 | `ahcStats.ts` читает не тот field path (provider возвращает cache, мы дропаем) | AI SDK провайдеры мапят cached tokens по-разному (V2 vs V3 shape) | In-route `console.log(usage)` в `onFinish` | **Rejected** — поле читается верно |
| H2 | Gemini-3-flash-preview implicit cache off (preview модель не поддерживает) | Преview-модели часто имеют partial feature support | Probe `gemini-2.5-flash` (known implicit cache) через OpenRouter | **Partially** — see H3 |
| H3 | OpenRouter не пробрасывает Gemini implicit-cache info вообще | `system_design.md:246` намекает; OpenAI-compat layer ≠ Gemini native | Probe **обе** Gemini модели + контроль OpenAI native + Anthropic | **Confirmed** |
| H4 | OpenRouter+OpenAI native models пробрасывают `prompt_tokens_details.cached_tokens` | OpenAI cache — стандарт OpenAI usage shape; OpenRouter сохраняет совместимость | Probe `gpt-4o-mini`, `gpt-5-nano`, `gpt-4.1-mini`, `gpt-5.4-mini` через OpenRouter | **Confirmed** |
| H5 | OpenRouter не пробрасывает Anthropic `cache_control` hint через OpenAI-compat | OpenAI Chat Completions API не имеет cache_control; OpenRouter мог бы транслировать, но не обязан | Probe `anthropic/claude-haiku-4-5` через OpenRouter с ephemeral marker | **Confirmed (not passed through)** |

## Evidence

### E1: In-route probe (`src/ui/app/api/chat/route.ts:onFinish`, MODEL_ID=`google/gemini-3-flash-preview`)

3 turn'а с identical system prompt + shared conversation prefix. Лог дамплен из
dev-server stdout:

| Turn | inputTokens | inputTokenDetails.cacheReadTokens | usage.raw.prompt_tokens_details.cached_tokens | cachedInputTokens | providerMetadata.openai |
|---|---|---|---|---|---|
| 1 | 402 | 0 | 0 | 0 | `{}` |
| 2 | 7606 | 0 | 0 | 0 | `{}` |
| 3 | 8026 | 0 | 0 | 0 | `{}` |

**Verdict E1:** все три layer'а repots zero. AI SDK правильно мапит field — `inputTokenDetails.cacheReadTokens` существует в payload (rejects H1). Provider/OpenRouter не возвращают cache info для Gemini-3-flash-preview даже при 8026 tok prompt (well above any threshold).

### E2: Standalone OpenRouter probe — Gemini family

`scripts/probe-openrouter-cache.ts` (deleted after investigation), system prompt ~3790
tok filler, 3 sequential POSTs per model:

```
=== Model: google/gemini-3-flash-preview ===
turn 1 prompt_tokens=3326 completion=56 cached_tokens=0 gen_id=gen-…
turn 2 prompt_tokens=3330 completion=56 cached_tokens=0 gen_id=gen-…
turn 3 prompt_tokens=3332 completion=56 cached_tokens=0 gen_id=gen-…

=== Model: google/gemini-2.5-flash ===
turn 1 prompt_tokens=3326 completion=16 cached_tokens=0 gen_id=gen-…
turn 2 prompt_tokens=3330 completion=12 cached_tokens=0 gen_id=gen-…
turn 3 prompt_tokens=3332 completion=22 cached_tokens=0 gen_id=gen-…
```

**Verdict E2:** обе Gemini модели через OpenRouter возвращают `cached_tokens=0`. Это
systemic OpenRouter→Gemini passthrough gap, не preview-specific.

### E3: OpenRouter → Anthropic Claude Haiku 4.5 с `cache_control: ephemeral`

`scripts/probe-openrouter-anthropic-cache.ts` (deleted), ephemeral marker на `system[0]`
content part:

```
turn 1 prompt=2182 completion=40 cached_in_details=0 cache_read=— cache_creation=—
turn 2 prompt=2183 completion=40 cached_in_details=0 cache_read=— cache_creation=—
turn 3 prompt=2177 completion=40 cached_in_details=0 cache_read=— cache_creation=—
```

**Verdict E3:** OpenRouter's OpenAI-compat → Anthropic translation **не пропускает**
`cache_control` hint. Поле `cache_read_input_tokens` вообще не возвращается. Опции
"переключиться на anthropic через OpenRouter с явным маркером" не работают без
дополнительной транслирующей логики.

### E4: OpenRouter → OpenAI native modules

`scripts/probe-openrouter-openai-cache.ts` (deleted), система prompt ~300×30 chars filler:

```
openai/gpt-4o-mini p= 1816 cached= 0
openai/gpt-4o-mini p= 1816 cached= 0
openai/gpt-4o-mini p= 1815 cached= 1664
openai/gpt-5-nano  p= 1815 cached= 0
openai/gpt-5-nano  p= 1815 cached= 0
openai/gpt-5-nano  p= 1814 cached= 1664
openai/gpt-4.1-mini p= 1816 cached= 0
openai/gpt-4.1-mini p= 1816 cached= 1664
openai/gpt-4.1-mini p= 1815 cached= 0
```

**Verdict E4:** OpenRouter → OpenAI native: cache info **проходит**. `prompt_tokens_details.cached_tokens`
заполняется на 3-й (gpt-4o-mini, gpt-5-nano) или 2-й (gpt-4.1-mini) turn идентичного
prefix. Threshold для cache hit — ≥1024 tok shared prefix.

### E5: OpenRouter → `openai/gpt-5.4-mini` (user-selected target)

`scripts/probe-openrouter-gpt54.ts` (deleted):

```
openai/gpt-5.4-mini p= 1815 cached= 0
openai/gpt-5.4-mini p= 1815 cached= 1280
openai/gpt-5.4-mini p= 1814 cached= 1280
openai/gpt-5.4-nano p= 1815 cached= 0
openai/gpt-5.4-nano p= 1815 cached= 0
openai/gpt-5.4-nano p= 1814 cached= 0
```

**Verdict E5:** `gpt-5.4-mini` кэширует с turn 2 уверенно. `gpt-5.4-nano` за 3 turn'а
кэш не активировал (возможно нужен больший prefix; не критично — `mini` достаточно).

### E6: LiteLLM proxy (`http://localhost:4400`) → Anthropic Claude Haiku 4.5 native messages с `cache_control`

```
turn 1 in=1811 out=30 cache_create=0 cache_read=0
turn 2 in=1811 out=30 cache_create=0 cache_read=0
turn 3 in=1811 out=30 cache_create=0 cache_read=0
```

**Verdict E6:** LiteLLM proxy либо strip'ает cache_control marker, либо upstream
Anthropic key не имеет prompt-cache feature enabled. Не investigated дальше —
не блокер для demo, путь через OpenAI native проще.

### E7: Live UI smoke с `openai/gpt-5.4-mini` + inflated system prompt (≥1024 tok stable prefix)

После switch MODEL_ID + расширения system prompt до stable ~1300 tok:

| Turn | input | output | cache_read | cumCost |
|---|---|---|---|---|
| 1 | 1,301 | (varies) | 0 | $0.0010 |
| 2 | 1,324 | 81 | **1,024** | $0.0021 |
| 3 | 1,422 | 12 | **1,024** | $0.0035 |

Screenshot: `.playwright-mcp/cache-probe-3turns-fired.png`.

**Verdict E7:** End-to-end cache reporting работает. `cache_read = 1024` (точно at-threshold), стабильный
от turn 2 onwards. Sidebar `tokens.cache_read` отображает корректно.

## Findings

| Source | Result | Confidence | Notes |
|---|---|---|---|
| E1 | ahcStats field path корректен | high | `inputTokenDetails.cacheReadTokens` существует в AI SDK v6 `LanguageModelUsage`, шапка из `node_modules/ai/dist/index.d.ts:267-289` |
| E2 | OpenRouter → Gemini (3-preview и 2.5) — cache_tokens=0 always | high | Even 8026 tok prompt не активирует. Не модель-specific, OpenRouter-level gap |
| E3 | OpenRouter → Anthropic через OpenAI-compat — cache_control marker dropped | high | `prompt_tokens_details.cached_tokens=0`, `cache_read_input_tokens` отсутствует |
| E4-E5 | OpenRouter → OpenAI native — cache passthrough работает | high | `gpt-4o-mini`, `gpt-5-nano`, `gpt-4.1-mini`, `gpt-5.4-mini` все возвращают `cached_tokens > 0` при ≥1024 tok shared prefix |
| E6 | LiteLLM proxy → Anthropic с ephemeral marker — cache_creation=0 | medium | Не дебажил глубже; demo path не требует |
| E7 | Live UI с `gpt-5.4-mini` + ≥1024 tok system prompt — cache_read=1024 от turn 2 | high | End-to-end demo ready |

## Interpretation

- **H1 rejected:** ahcStats читает корректное поле; bug не на нашей стороне.
- **H3 confirmed:** OpenRouter не пробрасывает Gemini implicit cache info. Это
  systemic, не preview-issue, согласовано с `system_design.md:246` ("OpenRouter
  doesn't always expose cache headers"). Гипотеза H2 (preview-specific gap)
  получается subsumed в H3 (universal Gemini gap).
- **H4 confirmed:** OpenRouter → OpenAI native — рабочий путь.
- **H5 confirmed:** OpenRouter не транслирует Anthropic-style `cache_control` через
  OpenAI-compat endpoint. Если хотим Anthropic с явным caching — нужен `anthropic_direct`
  провайдер (e.g. через LiteLLM), но E6 показал что **proxy сам по себе** не достаточен
  без дополнительной диагностики (out of scope).

**Decision triangle:**
1. **Keep Gemini, document gap** — противоречит user requirement "обязательно надо его добиться".
2. **Switch to `anthropic_direct`** — больший reach, AHC middleware уже эмитит `cacheControlEnabled=true` для этого провайдера, но E6 показал что LiteLLM путь требует дальнейшего дебага.
3. **Switch to OpenAI native через OpenRouter (`openai/gpt-5.4-mini`)** — minimal change (single MODEL_ID line + UI-local pricing), provider cache_read работает probe-verified. **Выбрано.**

## Next Actions

- **Action — DONE:** switch `MODEL_ID` в `route.ts:29` на `openai/gpt-5.4-mini`. Added UI-local pricing override в `src/ui/lib/ahcStats.ts:UI_PRICING_OVERRIDES` (eval/llm.ts untouched per E1-experiment-running constraint). Inflated `SYSTEM_PROMPT` до ~1300 tok чтобы guaranteeded cross OpenAI's 1024-tok cache threshold с turn 2.
- **Action — DONE:** `console.log(usage)` probe в `route.ts:onFinish` удалён.
- **Verification:** Live smoke в E7 + полный `./scripts/verify.sh` зелёный (505 unit
  tests + cache-invariance 4/4).
- **Decision entry:** **Не пишем** в `decisions.md` — per `feedback_decisions_threshold`
  это SDK provider quirk (OpenRouter→Gemini cache passthrough off), не архитектурный
  decision уровня E0/E3 cache subset. Investigation doc = правильный дом.
- **Harness entry:** не требуется — single occurrence, не повторяющаяся ошибка,
  `system_design.md:246` уже фиксировал caveat.

### Follow-ups (not blocking this commit)

- Если кто-то захочет демонстрацию AHC cache-hit на Anthropic — путь через
  `anthropic_direct` провайдер; перед этим — добить debug E6 (понять почему
  LiteLLM proxy не показал cache_creation на 1811 tok input).
- UI-local pricing для cached tokens — сейчас flat prompt rate $0.75/M для всего
  input. Reality: cached portion стоит $0.075/M (10× cheaper). Cost-display чуть
  пессимистичен. Если волнует точность — split на cached / non-cached в
  `buildAhcStats`. Не блокер: cumulative cost в demo всё равно низкий ($0.0035 за 3 turn'а).
