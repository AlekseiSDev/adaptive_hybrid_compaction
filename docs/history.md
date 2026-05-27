# Change History

Chronological log of significant changes to algorithm / dataset / tools /
instrumentation. Source для F-report Methodology + Results timeline.

Не дублирует `decisions.md` (там architectural rationale с deep context);
history = сжатая хронология «что менялось» — 1-2 строки per entry, дата +
subject + почему важно для отчёта. См. `CLAUDE.md §Change History` для
scope (что попадает / что нет).

Append-only. Новые записи внизу.

## Format

```
- **[YYYY-MM-DD] Subject** — one-liner: что изменилось + почему важно для отчёта.
  (Опционально: ссылка на commit / PR / decisions.md entry.)
```

## Entries

### Algorithm

- **[2026-05-22] OBSERVER_THRESHOLD default 8000 → 30000** — Track H Phase 8.
  Pre-bump observer fired каждый turn ≥2 на lme-multiturn (Tier-3 window
  ~4-7K) и съедал retention. Подняли чтобы AHC working window попадал в
  envelope Mastra OM (~25K). См. `decisions.md 2026-05-22 H Phase 8`.
- **[2026-05-22] Tier-2 cross-turn persistence + adaptive Tier-3 token budget**
  — Track H Phase 9. Pre-fix Tier-2 reset'ился каждый turn → §2.1 append-only
  contract vacuously satisfied. K_RECENT был hard message-count cap, не token
  budget. Result: AHC ran as `K_RECENT=6` drop-tail без summarisation.
  Fix: persist Tier-2 в `Map<SessionId, Tier2>`; `TIER3_TOKEN_BUDGET`
  (default = 30000) → Tier-3 grows past K_RECENT до token threshold.
  Critical change — без него AHC numbers на lme-multiturn были architectural
  noise. См. `decisions.md 2026-05-22 H Phase 9`.
- **[2026-05-26] Observer prompt rewrite (Mastra-style detail-preservation)**
  — `AHC_drop_K-recent_fixed_observations`. Pre-rewrite observer выкидывал
  численные ответы / имена (confabulation: task `01493427` → AHC "17" vs
  ground truth "25"). Переписали под Mastra-style structured extraction
  hint. Verification n=15 lme-multiturn: acc 0.200 → 0.333 (+13pp), но
  43/48 observer fires вернули пустые arrays (parse-failure на новом
  prompt). Open workstream (`current.md` Track H).
- **[2026-05-27] Observer parse-failure fix — accept ISO/slash date timestamps**
  — commit `68f1037`. Root cause найдена через новое diagnostic поле
  `observerRawText` (записывается в `records.ndjson` когда `parseObservations`
  вернул `[]`): 7/8 пустых fires из 2026-05-26 sweep'а — Gemini-3.1-Flash
  писал `- 2023-11-30 (high) ...` или `- 2023/08/11 (high) ...` где parser
  ждал integer epoch `(\d+)`. 8-й случай — refusal (LLM ответил "25" на
  user query вместо observations). Fix: parser принимает `YYYY-MM-DD` /
  `YYYY/MM/DD` / integer; prompt получил anti-answer-leak инструкцию +
  literal EXAMPLE OUTPUT блок. n=3 debug verify: non-empty obs rate 33%
  → 100% (12/12), killer task `01493427` отвечает "25" корректно. См.
  `decisions.md [2026-05-27]`. Closes 2026-05-26 open workstream.
- **[2026-05-27] Observer content-aware filter + Tier-2 persistence wiring**
  — commit `f789b7e`. Два связанных fix'а: (1) observer на каждом fire'е
  видит ТОЛЬКО messages с `metadata.turn_index > max(tier2.observations.sourceTurn)`
  — раньше LLM получал full Tier-3 (64k) каждый fire, был myopic к tail'у,
  middle-window sessions тихо терялись. (2) `tier2Registry` пробросан через
  `createAhcRuntime` → eval-side `ahc_core.ts` теперь persistит Tier-2
  через `baseline.step()` calls (H Phase 9 decisions claim был incomplete
  в eval path, observations не accumulated'ились). Result n=3 lme-mt debug:
  total cost $6.08 → $3.50 (−42%), observer overhead $4.41 → $1.69 (−62%),
  mean score 2/3 без регрессии. Same 82 fires но каждый input 25× меньше
  (одна new session, не full window). vs FC ($6.88, 3/3) — AHC@64k 49%
  cheaper; vs Mastra ($1.43, 3/3) — ещё 2.4× дороже (Step B target).
- **[2026-05-27] Pluggable observer/internal model (`ConfigDef.internal_model`)**
  — Step B of the observer-overhead PR. Новый sweep YAML knob:
  `internal_model: google/gemini-3.1-flash-lite-preview` маршрутизирует AHC
  internal LLM calls (observer/reflection/digest) через cheaper model вместо
  main actor. Main actor остаётся на `gpt-5.4-mini` (его умность важна
  для answer quality). Pricing 3× cheaper input ($0.25 vs $0.75 per-M),
  3× cheaper output. n=3 lme-mt debug на тех же 3 killer tasks:
  total cost $3.50 → **$2.63 (−25% on top of Step A, −57% from PRE)**,
  observer overhead $1.69 → **$0.94 (3× drop как и pricing)**, full-obs rate
  поднялся 80/82 → 82/82 (flash-lite extracted строже), mean score 2/3
  preserved. vs FC ($6.88, 3/3) — AHC@64k 62% cheaper; vs Mastra ($1.43,
  3/3) — AHC всё ещё 1.8× дороже (Mastra gap не закрыт; их 4.6× cheaper
  baseline на full n=15 lme-multiturn вероятно ещё больше — single-shot
  reflection vs наш per-turn extract). Sweep YAML
  `eval/sweeps/main_e1_text_lme_mt_n3_observer_t64k_flashlite.yaml`.
- **[2026-05-27] Tier-3 watermark: fire-on-threshold вместо fire-every-turn**
  — supersedes Step A's `floor=1` hack. Step A's content-filter в observer'е
  с floor=1 был workaround: tierize re-build'ила Tier-3 из full history
  каждый turn (всегда ≥threshold → observer всегда fires), а content-filter
  пытался сжимать LLM input по-новому. На самом деле fires count stayed at
  82 (one per turn). Правильное место для fix'а — **tierize**:
  `lastObservedTurn` parameter excludes уже-наблюдённые messages из
  Tier-3 candidates ДО token-budget walk. Tier-3 теперь стартует empty
  после fire'а, растёт сессия-за-сессией, пересекает OBSERVER_THRESHOLD
  естественно через ~25 сессий → ONE fire на batch → reset. Adapter
  (`ai-sdk-v6.ts`) computes watermark как `max(prevTier2.observations[].sourceTurn)`
  и passes в tierize. Observer возвращён к простой "threshold check → fire"
  shape (content-filter / floor=1 / throttleResult всё удалено).
  **Result на тех же 3 killer tasks:**
  - **fires 82 → 5** (16× меньше) — 1 per task для 01493427, 2 each для 07741c44/07b6f563
  - **mean score 2/3 → 3/3** (matched FC + Mastra accuracy)
  - total cost $3.50 → $3.47 (~wash — observer overhead −$0.27, но actor input
    +$0.25 потому что accumulates до threshold вместо clip)
  - killer task `01493427` всё ещё ✓ "25 postcards"; **07741c44 теперь ✓**
    (раньше failed на всех configs кроме FC/Mastra); 07b6f563 ✓
  **Observer-model swap experiments** (Step B `internal_model` knob):
  - `gpt-5.4-mini` (default, актер model): 3/3, $3.47, 5 fires — canonical
  - `gemini-3.1-flash-lite`: 2/3 (07b6f563 ✗), $3.23 — generic phone-accessories answer
  - `gemini-2.5-flash` (Mastra default): **1/3** (01493427 + 07741c44 ✗), $3.26 —
    разные tasks failing, разный failure mode; парадокс что Mastra на этой же
    модели 3/3 — указывает на prompt-mismatch (наш observer prompt оптимизирован
    под gpt-extraction-style, не под Mastra-style coverage). Step C3 prompt
    rewrite (Mastra-style coverage instructions) пропущен в этом PR — мог бы
    закрыть gap, но рискует current 3/3. Отложен как follow-up workstream.
  Production canonical: gpt-5.4-mini observer. Mastra gap closure: vs Mastra
  ($1.43, 3/3) AHC@64k теперь 2.4× дороже но 3/3-equivalent на этих 3 задачах.
  Mastra win на cost остаётся (single-batch reflection + 2.5-flash их default).
  Sweep YAMLs: `main_e1_text_lme_mt_n3_observer_t64k.yaml` (canonical),
  `..._t64k_flashlite.yaml` (experimental, regression documented),
  `..._t64k_gemini25flash.yaml` (experimental, regression documented).
- **[2026-05-27] K-tail-3 — recall-protocol injection + two-stage rehydration
  + content-aware digest (gaia-med acc 0.20 → 0.44)** — K-tail-2 audit
  показал `recall_tool_result` invocations = 0 across 25 gaia-med tasks:
  GAIA driver-system prompt не упоминал pointer'ы, single-tool recall
  inject'ился middleware'ом без execute path, digest = 80-token LLM-summary
  поверх 20-50K web_search dump'ов (lossy). Три coupled fix'а в одном
  cycle. (1) **Centralized recall-protocol injection** в system prompt
  (`src/adapters/ai-sdk-v6.ts:injectRecallProtocolNote`) — frozen literal
  text appended как 2-й system message когда `RECALL_TOOL=true` +
  scratchpad non-empty; actor видит формат stub'а и сигнатуру recall
  tools. (2) **Two-stage rehydration**: split `recall_tool_result` → пара
  `recall_tool_summary` (cheap, content-aware) + `recall_tool_full` (raw
  fallback). Stub format переписан с inline digest на `[Offloaded #G1
  tool=<name> size=<N>B — summary: recall_tool_summary(G1); raw:
  recall_tool_full(G1)]`. Scratchpad payload расширен с `AtomicGroup` →
  `{group, summary}` чтобы summary computed-once-at-offload жил вместе
  с raw payload. (3) **Content-aware digest** (`CONTENT_AWARE_DIGEST`
  flag, default off): per-tool projectors заменяют LLM-digest на rule-based
  projection — `web_search` → top-N {title,url,snippet_head_300};
  `visit_webpage` → {title, head_800+tail_400}; `python_exec` → {stdout_head,
  stderr, exit_code}; `text_editor` → {path, size, content_head_600};
  `describe_image` → description verbatim if ≤2000 chars. (4) **Wire
  execute path** — `gaiaTools(workspaceDir, recallDeps?)` factory принимает
  scratchpad + tier-2 pointers и appends `recall_tool_summary` /
  `recall_tool_full` tools с execute resolution; middleware-side schema
  injection остаётся для visibility, runner-side execute resolves dispatch.
  Plus три side fix'а из debug pass'а: (a) `offloader.ts` — replacement
  map keyed by `(message, tool_use_id)` чтобы parallel tool calls не
  затирали друг друга на одном tool message; (b) dedupe recall tool
  injection (middleware + runner оба inject'или → AI SDK падал на duplicate
  name); (c) `visit_webpage` Content-Type whitelist (text/*, application/xhtml,
  rss/atom/feed) — throws на application/pdf, image/jpeg, octet-stream
  (раньше res.text() на PDF дампило 123KB UTF-8-decoded binary в actor context
  на gaia_010). **Verification** (`main_e1_gaia_ahc_v3.yaml`, n=25, seed=42,
  64K Tier-3 / 100K Tier-2 thresholds, $0.93): **acc=0.440 (11/25)** vs
  K-tail-2 AHC=0.200, vanilla=0.320, Mastra=0.400. Per-level: L1 4/7 (0.57)
  / L2 7/14 (0.50, +3 vs K-tail-2) / L3 0/4. Cost 62% ниже Mastra ($0.93
  vs $2.47), 31% ниже vanilla ($0.93 vs $1.35). Observer теперь реально
  fires на heavier tasks (gaia_010 input 115K, gaia_016 83K, gaia_013 79K
  — все пересекают 64K threshold). Probe'ы перед sweep'ом (5 trajectories
  через `scripts/probe-rehydration-deeper.ts`) поймали bug'и (a)/(b)/(c) до
  full run'а. См. `baselines_frozen.md` gaia-med section + `decisions.md
  2026-05-27 two-stage recall`.
- **[2026-05-27] K-tail-4 — Anthropic /compact + tools as 4th GAIA baseline
  (Sonnet 4.6 acc 0.60 @ $15.82, 0 compaction fires)** — добавили 4-й
  baseline на GAIA-med: Anthropic's server-side `compact_20260112` agent с
  tools, через native Anthropic SDK. Тот же `GAIA_DRIVER_SYSTEM`, тот же
  `gaiaTools()` (5 GAIA-tools), AI SDK обойдён (beta knobs
  `betas: ['compact-2026-01-12']` + `context_management.edits[].type` не
  пробрасываются reliably через provider plug). New stand-alone agentic
  runner `src/eval/adapters/gaia-med/anthropic-compact-runner.ts`
  (290 lines) mirror'ит `mastra-agent-runner.ts` shape. Auth priority:
  LITELLM proxy preferred → ANTHROPIC_API_KEY direct fallback.
  Two findings из pilot + n=25. (1) **Haiku 4.5 не поддерживает
  `compact_20260112`** — Anthropic API 400: `'claude-haiku-4-5-20251001'
  does not support the 'compact_20260112' context management strategy`.
  Feature — Sonnet+/Opus only. Дроп haiku из sweep'а, оставлен только
  Sonnet 4.6. (2) **0 compaction events fired на n=25** — cumulative input
  grew до 940K на heaviest tasks, но per-call `messages.create` input не
  пересекал default 100K trigger threshold. Vendor's threshold слишком
  высокий под структуру multi-tool GAIA tasks — /compact feature на этом
  bench'e фактически inactive. **Numbers**: acc=0.600 (15/25) — headline
  acc на GAIA-med. Per-level: L1 5/7 / L2 9/14 / L3 1/4 (единственный
  baseline разломавший L3 ceiling). Cost $15.82 — 17× дороже AHC K-tail-3
  ($0.93). По cost-per-correct AHC побеждает 12×: AHC $0.084/correct vs
  sonnet $1.054/correct. Sonnet's acc gain — model strength
  (gpt-5.4-mini→sonnet-4.6 upgrade), не /compact strategy. Implication
  для report'а: AHC's value prop (middleware-side compaction с
  threshold-tuning) сохраняется на agentic benches — vendor's static
  100K threshold даёт zero effect когда per-call context остаётся под
  порогом; AHC's tunable 64K порог fires реально и достигает comparable
  accuracy за порядки величин меньшую цену. См. `baselines_frozen.md`
  gaia-med section ✠✠✠✠ footnote + `decisions.md 2026-05-27 K-tail-4`.

### Dataset / Benches

- **[2026-05-13] AssistantTraj v1 — 30 jay-canvas-seeded tasks** — Track D
  closed. Source — `jay-canvas/apps/platform/api/e2e/golden-set/scenarios/`
  (single-letter category codes). Replay-only через `buildRunnerFromBaseline`.
- **[2026-05-22] AssistantTraj v2 — 50 tool-grounded tasks** — Track J3.
  AT-v1 30 task files retired (`git rm`). 4-tool palette (`image_gen`,
  `google_search`, `web_fetch`, `code_interpreter`). Cross-field rule:
  `expected_tool_calls.required` ↔ `tools_available[]`. J6 sweep pending
  (numbers в `baselines_frozen.md` Text benches table с пометкой "AT-v2").
- **[2026-05-22] Track K — gaia-med bench (n=25 effective)** — добавлен
  5-й bench (cross-domain agentic). 5 tools: `web_search`, `visit_webpage`,
  `text_editor`, `python_exec`, `describe_image`. Pure-normalization grader
  (faithful upstream GAIA, no LLM-judge). 5/30 attachment tasks filtered
  at bake (xlsx/pdf/pdb/jsonld/docx not vendored).
- **[2026-05-26] К-tail-2 Mastra threshold bump 30K/40K → 100K/200K** —
  Mastra observationalMemory fire слишком aggressive на GAIA multi-tool
  tasks (60-95K context). После bump'а: Mastra acc 0.28 → 0.40, empty
  4/25 → 1/25. См. `baselines_frozen.md` gaia-med section.
- **[2026-05-27] AssistantTraj v3 — corpus rebuild from jay-canvas golden-set**
  — Tracks D6 + J7. AT-v2 был не-валиден для medium-traj оценки:
  все 50 задач single-turn, все 50 sidecar fixtures = placeholder text,
  29 synthetic с шаблонным `expected_summary`. AT-v3 = **63 multi-turn задач**
  (turns 1-2) reimported из `jay-canvas/apps/platform/api/e2e/golden-set/scenarios/`
  (категории IG/IE/CD/QA/A/ED/WC/MX/DBG, скип VG/MUS/AM), captured
  `turn.tool_outputs` заменяют placeholder'ы. 29 AT-v2 synthetic deleted,
  21 opensource marked `provenance.deprecated=true` (фильтруются default'ом).
  Tool палитра расширена с 4 до 5 (added `image_edit`); все 5 тулов
  получили live wrappers через Gemini-Imagen / Brave / Firecrawl / E2B
  (`AT_TOOL_MODE=live` для bake-fixtures). Adapter и runner уже поддерживали
  multi-turn reroll out-of-the-box (`buildRunnerFromBaseline` итерирует
  `conv.messages`) — поле `execution_mode` добавлено в schema для будущей
  селективности. Validator hardened: attachment file existence, fixture
  placeholder / `needs_bake` guards, real-source provenance lineage check.
  9 needs_bake fixtures забейкены через live Gemini/E2B (4 потребовали
  re-bake — Gemini отказывался на длинных русских image-gen промптах,
  пофикшено заменой на короткий generic prompt). **Verification**:
  competitor smoke sweep `eval/sweeps/at_v3_smoke_competitors.yaml`
  (3 configs × 5 tasks, budget $2): all 15 runs completed без adapter
  ошибок, total cost $0.20, mean primary 0.30 для всех трёх (full_context,
  mastra_om, ahc_full). Числа спот-проверка sanity, не accuracy-вердикт —
  E1 re-run с полным корпусом — отдельный PR. Deferred: synthetic
  continuation для растягивания до 5-7 turns (Step 4 plan); judge
  re-calibration на новой выборке (Step 8 plan). См. `decisions.md
  2026-05-27 AT-v3 multi-turn execution mode`.

### Tools

- **[2026-05-13] Tau-bench retail tools port (10 из 16 upstream)** — Track D5.
  Subsetted out `exchange` / `payment-method-modification` / `list-product-types`
  как 90%+ retail flows покрываются меньшим набором. Documented divergence
  на 1-2 episodes из 10.
- **[2026-05-22] GAIA 5-tool surface portированы из Holosophus** — Track K2.
  `python_exec` NOT Docker-sandboxed (subprocess + 30s timeout) — caveat
  для F-report. SearXNG self-hosted (free) + Tavily/Brave fallback.

### Models / Pricing

- **[2026-05-13] Actor → `openai/gpt-5.4-mini`** — supersedes
  `gemini-3-flash-preview`. Выбрано за automatic prompt caching на OpenRouter
  (no `cache_control` plumbing required); ~80% hit на ≥1024-token prefix.
  Verified live: cached_tokens 0 → 2304 (80.8%) на calls 2-3. См.
  `decisions.md 2026-05-13`.
- **[2026-05-13] Judge → `anthropic/claude-sonnet-4.6` via OpenRouter** —
  D4. Cross-vendor с actor (gpt-5.4-mini), vision-capable для AT image_qa.
  `claude-sonnet-4-7` ещё не на OpenRouter — fallback на 4.6 verified live.

### Instrumentation / Eval harness

- **[2026-05-13] B4 — Self-hosted Langfuse stack + zero-touch bootstrap**
  — `observability/docker-compose.yml` через `LANGFUSE_INIT_*` env vars;
  deterministic dev keys в `.env.example`. Opt-in (`LANGFUSE_ENABLED=true`).
- **[2026-05-13] B5 — AHC runtime integration через AI SDK v6 middleware**
  — `ahcCoreBaseline` оборачивает `openai.chat(model)` через
  `wrapLanguageModel({createAhcMiddleware})`; `experimental_telemetry:
  {isEnabled, functionId: 'ahc.step'}` → AI SDK auto-spans nest'ятся под
  `eval.task`.
- **[2026-05-26] B6 — Langfuse session/trace/span hierarchy** — `eval.task`
  стал root trace (ROOT_CONTEXT), `langfuse.session.id = ${bench}-${config_id}-${seed}`,
  `eval.turn` span per `baseline.step()` / per agent round. Tool spans
  через AI SDK auto-emission (`type=TOOL` discriminator). Verifier
  `scripts/check-langfuse-hierarchy.ts`.
- **[2026-05-26] B6+ Langfuse cost rollup — пере custom pricing registration**
  — нашли что `openai/gpt-5.4-mini` отсутствовал в built-in Langfuse pricing
  table (отсюда cost=$0 в UI). Зарегистрировали 5 моделей через
  `POST /api/public/models` (input/output цены из `OPENROUTER_PRICING`).
  TODO `scripts/langfuse-register-pricing.ts` для post-wipe recovery
  (`current.md` Track B).
