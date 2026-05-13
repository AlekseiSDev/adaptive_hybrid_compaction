# Track H Design — Ablations & Follow-up Runs

> Track-level design для **второй волны** прогонов после Phase D fast-track
> headline (commit `e-phase-d-fast`, `gpt-5.4-mini`, single-seed). Цель —
> закрыть статистические / cross-model / scale-up gap'ы, на которые F-report
> опирается за пределами single-seed headline.
>
> Тонкий слой над `design/E_main-runs.md` (orchestration / cost / pre-flight
> примитивы переиспользуются). H — execution-only трек, новый код только
> где Phase H фиксит inhonesty (env-override hardening, optional 2nd
> Anthropic competitor).

---

## Meta

- **Initiative:** Track H (H1 infra → H2 cross-model → H3 multi-seed → H4 extended ablations → H5 scale-up → H6 analysis)
- **Wall-clock:** 1.5–2 дня (большая часть — wait for sweeps; ~30 минут code в H1)
- **Бюджет:** ~$45–55 OpenRouter (текущий remaining ~$90 of $500)
- **Зависит от:** Phase D fast-track artifacts (`e-phase-d-fast` tag,
  `benchmarks/runs/main_e1_text/**/42/` headline), commit `5892063`
  (gpt-5.4-mini defaults), tau-bench grader fix (commit `d9d1424`).
- **Блокирует:** Track F (report). F-числа за пределами single-seed
  headline требуют H3/H4 для variance + power; cross-model claim
  требует H2.
- **Связь:** `system_design §7.2 Track H` (нужно добавить scope row —
  см. Open question 1), `design/E_main-runs.md §3-§6` (orchestration
  primitives), `design/A_ahc-algorithm.md §2.1` (cache-hit target
  verified in H6), `decisions.md [2026-05-13] actor model pivot`,
  `docs/runs/e_sweep_audit.md` (Phase D headline this track extends),
  `memory/feedback_verify_code_state_before_sweep.md` (rationale for
  H1).

---

## Outcomes

### Track H (after H6)

**Доступно:**
- `benchmarks/runs/main_e1_text_gemini/**/42/` — cross-model replica
  on `google/gemini-3-flash-preview` (4 baselines × 3 benches × seed=42).
- `benchmarks/runs/main_e1_text/**/43/` — seed=43 replication of
  Phase D gpt-5.4-mini sweep (12 new cells; auto-resume preserves 42).
- `benchmarks/runs/ablation_e2/**/{42,43}/` — extended E2 grid
  (3 ablation configs × 2 benches × 2 seeds, on gpt-5.4-mini only;
  Gemini cross-model ablation deferred unless H2 surfaces large
  cross-model delta).
- `benchmarks/runs/main_e1_tau/**` — tau n=30 re-run with fixed
  grader (post-`d9d1424`).
- `benchmarks/runs/cache_hit_e3/**` — real LongMemEval cells (not
  smoke fixtures), Sonnet via LITELLM.
- `docs/runs/h_followup_audit.md` — consolidated post-run audit
  (replaces `e_sweep_audit.md` as the F-report numeric source of
  truth).

**Demo:**
```bash
pnpm tsx scripts/sanity-aggregate.ts benchmarks/runs/main_e1_text/
pnpm tsx scripts/sanity-aggregate.ts benchmarks/runs/main_e1_text_gemini/
# Side-by-side accuracy table; F-report consumes both.
```

**Acceptance gate:** `./scripts/verify.sh` зелёный (H1 не регрессирует
+ optional H2 baseline coverage) + `pnpm tsx scripts/check-run.ts` на
всех новых run dirs exit 0 + per-cell `summary.json.status='complete'`
для не-halted ячеек + total spend ≤ $60 + cross-replication ahc_full
gpt5.4-mini seed42↔43 within 2× SEM.

### Per-phase

| Фаза | Artifact | Verify |
|---|---|---|
| **H1** Cross-model env-override hardening | 2 файла обновлены (`runner.ts`, `mastra_om.ts`) so `AHC_ACTOR_MODEL` env affects ВСЕ 4 default constants symmetrically. New unit tests cover env-precedence. | `pnpm exec vitest run src/eval/runner.test.ts src/eval/baselines/mastra_om.test.ts` зелёный; smoke: `AHC_ACTOR_MODEL=google/gemini-3-flash-preview pnpm tsx scripts/eval.ts --sweep smoke.yaml --dry-run` → resolved cells all `google/gemini-3-flash-preview`. |
| **H2** *(optional)* 2nd Anthropic competitor (LangChain SummaryBufferMemory или Anthropic Cookbook «memory tool») | Новый baseline в `src/eval/baselines/<name>.ts` + ячейка в `main_e1_text.yaml`. ~150-250 LOC. | Unit tests baseline contract; live mini-smoke 1 task на AT → records.ndjson `final_response_text` non-empty + cost > 0. |
| **H3** Cross-model main sweep (gemini-3-flash) | `benchmarks/runs/main_e1_text_gemini/**` — 12 cells. `~$8` spend. ~15 мин wall-clock. | `check-run.ts` exit 0; `sanity-aggregate.ts` — eyeball «no all-1.000 saturation, cache_read=null OK as Gemini doesn't auto-cache». |
| **H4** Multi-seed replication (seed=43) | 12 fresh cells under `benchmarks/runs/main_e1_text/**/43/` (gpt-5.4-mini). + optional 12 cells `main_e1_text_gemini/**/43/`. `~$13` total. ~30 мин wall-clock. | seed42↔43 ahc_full accuracy delta ≤ 2× SEM (sanity); если > — flag in audit, not block. |
| **H5** Extended ablations on real subsets | `benchmarks/runs/ablation_e2/**/{42,43}/` — 3 configs × 2 benches × 2 seeds × n=20 = 12 cells. `~$10`. ~20 мин. | ahc_full E2 within stderr of ahc_full E1 на тех же benches; component deltas (no_observer / no_offloader) surface > seed-spread floor. |
| **H6** Scale-up + cache rate + analysis | Tau n=30 rerun (~$1.50), E3 real LME (~$5), AT loss per-class report (analysis-only), mastra_om OM execution depth audit (analysis-only). | check-run.ts; AT per-class report показывает где AHC теряет ≥3pp vs full_context; OM debug-event log non-empty на LME haystack tasks. |

---

## Phase map

| Фаза | Depends | Blocks | Core | Контракты | TDD seed | Cross-cutting |
|---|---|---|---|---|---|---|
| **H1** Cross-model env hardening | — | H3, H4 (Gemini variants), H5 (cross-model option) | §2 | `process.env['AHC_ACTOR_MODEL']` контракт + tests; `FULL_CONTEXT_DEFAULT_MODEL`, `DEFAULT_MODEL_ID` теперь читают env | failing test: `AHC_ACTOR_MODEL=foo` → `resolveFullContextModel() === 'foo'` (сейчас вернёт хардкод) | `decisions.md` entry (env-override semantics), `memory/feedback_verify_code_state_before_sweep.md` |
| **H2** *(opt)* 2nd Anthropic competitor | — | H3, H4, H5 (если baseline включён) | §3 | new baseline contract (`Baseline` from `src/eval/types.ts`), YAML config row | smoke YAML 1-cell live → records.ndjson valid + check-run.ts exit 0 | `design/C_baselines.md` (new entry — same PR) |
| **H3** Cross-model main sweep | H1 | F | §4 | sweep YAML `main_e1_text_gemini.yaml` (новый clone main_e1_text.yaml с `AHC_ACTOR_MODEL` env note), output dir `main_e1_text_gemini/` | `--dry-run --n-per-cell=1` resolves all 12 cells на Gemini; preflight OpenRouter auth OK | `design/E_main-runs.md §3` (concurrency), §6.1 (failure modes) |
| **H4** Multi-seed | H1, Phase D headline (commits to compare) | F | §5 | edit `main_e1_text.yaml`: `seeds: [42, 43]`; auto-resume через NDJSON | seed42 cells остаются нетронутыми; seed=43 dry-run resolves 12 new cells | `design/E_main-runs.md §5` (replication semantics) |
| **H5** Extended ablations | H1, H3 (если cross-model ablation), Phase D ahc_full | F | §6 | edit `ablation_e2.yaml` (drop smoke fixture refs, ensure real subsets) | E2 ahc_full на AT within 2× SEM Phase D ahc_full на AT | `design/E_main-runs.md §9` post-run audit |
| **H6** Scale-up & analysis | Phase D tau bake (`d9d1424`), instrumented mastra_om (H6.4) | F | §7 (tau scale), §8 (E3 real), §9 (analysis hooks) | tau YAML unchanged (re-run on extended bake); cache_hit_e3.yaml unchanged; new `scripts/per-class-report.ts` ALREADY exists (per Phase D commit) | tau mini-smoke 1 ep → reward ∈ [0, 1) non-trivially; E3 mini-smoke 1 task → `cache_read_input_tokens > 0` на 2nd turn | `design/A_ahc-algorithm.md §2.1` cache target, `design/D_assistant-traj.md §9` per-class taxonomy |

**Parallelization:**

- **H1** обязательно first (всё cross-model depends on env-override).
- **H2** independent от H1 — может стартовать параллельно (новый baseline + design row в `C_baselines.md`).
- **H3 ∥ H4 ∥ H5** после H1 могут стартовать параллельно если OpenRouter rate-limit позволяет (preflight `usage / limit` check first). Sequential default — sweeps пишут в разные dirs, file lock не пересекается; concurrent ограничен только API rate-limit (~5-10 concurrent req на ключ — fits 3 sweeps × conc=3 each).
- **H6** scale-up sub-runs (tau, E3) independent друг от друга; analysis sub-tasks (AT per-class, OM audit) — post-hoc, не требуют live API.

**Orthogonal / deferred:**

- §11 cross-model E2 ablations (gemini-3-flash × no_observer / no_offloader) — defer unless H3 shows ≥3pp cross-model delta on headline accuracy.
- §10 D3 synthetic AT generation (n=30 → n=60) — separate Track D continuation; mentioned here only because H5 ablation power scales with n_AT.

**Как пользоваться.** Phase map — context router; перед фазой читай только Core + Контракты + TDD seed. Прогресс трекается через TaskCreate (per-sweep). План шагов — `/plan-mode` (триггерит пользователь).

---

## 1. Scope

**In (Track H):**
- Cross-model honest comparison (gpt-5.4-mini vs gemini-3-flash) headline.
- Multi-seed (42 + 43) для variance / paired permutation power.
- Extended E2 ablation grid с real subsets (post-Phase-D).
- Scale-up runs где n был мал в Phase D (tau 10→30, AT possibly 30→60).
- E3 cache rate verification на real LongMemEval (Phase D version still smoke).
- Optional new Anthropic-protocol competitor.
- Analysis hooks (AT per-class loss; mastra OM execution depth).

**Out (Track H):**
- Sweep YAML schema changes (live in Track B).
- Statistical pipeline (live in Track B / used in Track F).
- New benches beyond what Track D already provides.
- Long-trajectory (15+ turns) scope — non-goal v1 per `system_design §1.1`.
- Track F write-up — H delivers numbers, F writes prose.

---

## 2. H1 — Cross-model env-override hardening

### 2.1 Why this exists

Phase D pivot to gpt-5.4-mini was applied via 4 default-constant swaps (commit `5892063`). The constants:

| File | Constant | Reads env? |
|---|---|---|
| `src/eval/runners/ahc_core.ts:46` | `DEFAULT_OPENROUTER_MODEL` | ✓ via `envActorModel()` |
| `src/eval/adapters/tau-bench-retail/agent-runner.ts:40` | `TAU_ACTOR_FLASH_DEFAULT` | ✓ via `resolveTauActorDefault()` |
| `src/eval/runner.ts:158` | `FULL_CONTEXT_DEFAULT_MODEL` | **✗ hardcoded** |
| `src/eval/baselines/mastra_om.ts:54` | `DEFAULT_MODEL_ID` | **✗ hardcoded** |

→ Running `AHC_ACTOR_MODEL=google/gemini-3-flash-preview pnpm tsx scripts/eval.ts ...` сейчас даёт **asymmetric sweep** (AHC + tau на Gemini, full_context + mastra_om на gpt-5.4-mini). Это false-comparison и сжигает $20 на дефектный артефакт.

### 2.2 Contract

Add `resolveActorModel(defaultId: string)` helper в `src/eval/llm.ts` (shared utility, не дублировать в 4 файлах). Все 4 default-constant call sites переходят на него.

```ts
// src/eval/llm.ts
const ENV_VAR = 'AHC_ACTOR_MODEL'
export function resolveActorModel(defaultModelId: string): string {
  const v = process.env[ENV_VAR]
  return v && v.length > 0 ? v : defaultModelId
}
```

Per-file changes (~3 LOC each):

- `src/eval/runner.ts`: `model: FULL_CONTEXT_DEFAULT_MODEL` → `model: resolveActorModel(FULL_CONTEXT_DEFAULT_MODEL)`.
- `src/eval/baselines/mastra_om.ts:85` (in `resolveMastraModel`): `modelId: deps.modelId ?? DEFAULT_MODEL_ID` → `modelId: deps.modelId ?? resolveActorModel(DEFAULT_MODEL_ID)`.
- Existing `envActorModel()` helpers в `ahc_core.ts` и `agent-runner.ts` — заменить на import shared helper (DRY).

### 2.3 Tests (TDD seed)

`src/eval/llm.test.ts` (new):
- `resolveActorModel('default')` без env → `'default'`.
- С `AHC_ACTOR_MODEL=foo` → `'foo'`.
- С пустой строкой → `'default'`.

`src/eval/runner.test.ts` (add):
- `makeFullContextRunner(...)` reads model from env when set (mock process.env).

`src/eval/baselines/mastra_om.test.ts` (add):
- `buildMemoryOptions({apiKey: 'x'})` with `AHC_ACTOR_MODEL=foo` → `model.modelId === 'foo'`.

### 2.4 Failure modes

- **Env leak в parallel sub-processes** — if в будущем sweeps spawn child workers, env-var inheritance must be tested. Mitigation: assert env-set behavior in integration smoke YAML.
- **Override на cross-bench mixed sweep** — `AHC_ACTOR_MODEL` глобален, не per-cell. Если нужно gpt-5.4-mini для AT + Gemini для LME в одном sweep — нужна per-cell `actor_model` field в YAML (out of scope H1; flag в Open Q).

---

## 3. H2 — Second Anthropic competitor *(optional)*

### 3.1 Status

**Pending user decision.** Текущий `anthropic_compact` baseline уже среди 4 в main sweep (Sonnet-4.6 via LITELLM, conversation-level summarization когда context bloats). Если пользователь хочет **второй** Anthropic-стиль competitor, кандидаты:

- **LangChain `ConversationSummaryBufferMemory`** — industrial-standard rolling summary baseline. Requires `langchain` npm dep (heavy; consider isolated workspace package). ~200 LOC adapter.
- **Anthropic Cookbook «memory tool»** ([anthropics/anthropic-cookbook](https://github.com/anthropics/anthropic-cookbook)) — vendor-blessed long-running-memory pattern using `Read/Write/Edit` tool emulation. ~150 LOC adapter. Closest to AHC's own framing.
- **Letta** (formerly MemGPT, agent-managed external memory) — out of scope (cross-session focus, не medium-traj per `system_design §1.2`).

### 3.2 Recommended если пользователь подтверждает

**Anthropic Cookbook memory tool** — closer fit to AHC's positioning, vendor reference, fits в medium-traj framing. Add `src/eval/baselines/anthropic_memory_tool.ts` per `design/C_baselines.md` template (same shape as `anthropic_compact.ts`).

Implementation шаблон в same PR с обновлением `design/C_baselines.md` (per memory `feedback_phase_intro_doc_update.md` — phase-intro doc update lands as Step 0 of the same plan).

### 3.3 Decision gate

H2 запускается ТОЛЬКО если user явно подтвердит. Иначе skip и переходим к H3.

---

## 4. H3 — Cross-model main sweep (gemini-3-flash)

### 4.1 Why

Phase D headline числа (commit `e-phase-d-fast`) — на одной модели. F-report claim «AHC reduces tokens by X% при ≤Ypp accuracy loss» — provider-specific без cross-model anchor. Gemini-3-flash — natural foil:
- **Different cache regime** — см. §4.6 ниже. OpenRouter дропает Gemini cache; direct Google API кэширует на ~56% prefix. Выбор route определяет, что мы измеряем.
- **Different actor capability ceiling** — Gemini-3 имеет другой compaction-survival profile на multi-turn AT.

### 4.2 Pre-launch checklist

- [x] H1 merged (env-override hardened — без этого asymmetric sweep).
- [ ] Create `eval/sweeps/main_e1_text_gemini.yaml` — clone of `main_e1_text.yaml`, no body changes (модель резолвится через env).
- [ ] Verify `git log --oneline -1` includes H1 commit before launch.
- [ ] OpenRouter `/auth/key` preflight (uses ~$0.001).

### 4.3 Command

```bash
set -a && . ./.env && set +a
AHC_ACTOR_MODEL=google/gemini-3-flash-preview \
  pnpm tsx scripts/eval.ts --sweep eval/sweeps/main_e1_text_gemini.yaml \
  --concurrency=10 --max-tasks-per-cell=20
```

### 4.4 Expected output / cost

- 4 baselines × 3 benches × seed=42 × n=20 = 240 records.
- Cost: ~$8 (Gemini-3-flash cheaper input; output similar). Budget cap в YAML — $20.
- Wall-clock: ~15 мин (anthropic_compact still slowest path; rest на Gemini-3 quick).

### 4.5 Sanity gates

- `pnpm tsx scripts/check-run.ts benchmarks/runs/main_e1_text_gemini/` — all 12 cells `status='complete'`, `final_response_text` non-empty, cost_usd>0.
- `cache_read_input_tokens` expectation **зависит от выбранного route** (см. §4.6):
  - OpenRouter route (status quo, no provider change) → `0` или `null` (OpenRouter
    дропает `cachedContentTokenCount` для Gemini моделей; не failure).
  - `google_direct` route (после H3.1 миграции) → ожидаемо `> 0` начиная с turn ≥ 2
    при stable system prefix ≥ ~1k tok; ~56% prefix hit на gemini-3-flash-preview per
    probe 2026-05-13 (`docs/investigations/openrouter-cache-passthrough.md` round 2).

---

### 4.6 H3.1 — Eval-side switch to `google_direct` provider (gates real cache_read)

**Откуда возникло.** Probes 2026-05-13 (см. `docs/investigations/openrouter-cache-passthrough.md`)
показали:
- OpenRouter → `google/gemini-3-flash-preview` → `cached_tokens = 0` always, **OpenRouter
  strips the field** в OpenAI-compat translation (verified 3 раза, 3 модели Gemini).
- Direct `@google/genai` SDK → `gemini-3-flash-preview` → `usageMetadata.cachedContentTokenCount = 2033`
  (56% hit rate) с turn 2 на 8 подряд вызовов с ~3630 tok system prefix.

**Implication для H3.** Status-quo H3 sweep (OpenRouter route) корректен как "honest comparison
on the OpenRouter-deployed path", но **не измеряет AHC's cache-hit advantage** для Gemini —
provider просто не пробрасывает данные. F-report cross-model claim получается weak ("cache_read
null because pipeline can't see it", не "because model doesn't cache"). Если H3 хочет
честно сказать "cache rate on Gemini is X%" — нужен direct route.

**Решение.** Cross-model sweep H3 разветвляется на 2 sub-sweep'а:
- **H3-OR (status quo):** OpenRouter route. Honest "what end-user via OpenRouter sees".
  cache_read=0 expected; reporting в F-report зафиксирован как provider-routing limitation.
- **H3-GD (new, requires H3.1):** `google_direct` route via `@ai-sdk/google`. Реальный
  cache_read non-zero. Headline cache-hit number для Gemini-3.

**Что нужно поменять в eval-side для H3-GD.** Все 4 default constants должны принять
`'google_direct'` как provider option (сейчас все hardcoded на `'openrouter'`):

| Файл | Текущее (line) | Изменение |
|---|---|---|
| `src/adapters/ahc-runtime.ts:36` | `AhcProvider = 'openrouter' \| 'anthropic_direct'` | + `\| 'google_direct'`; добавить case в `buildBaseModel` (lines 79-110) для `createGoogleGenerativeAI({apiKey, baseURL?}).chat?(model)` либо `(model)`. cacheControlEnabled остаётся false (implicit cache automatic, нет hint). |
| `src/eval/runners/ahc_core.ts:43` | `DEFAULT_OPENROUTER_MODEL = 'google/gemini-3-flash-preview'` | Не трогать. Provider switching — runtime-side, через новый env `AHC_ACTOR_PROVIDER=google_direct` или sweep-level `provider:` поле. |
| `src/eval/runner.ts:154` | `FULL_CONTEXT_DEFAULT_MODEL = 'google/gemini-3-flash-preview'` | То же — runtime читает provider override. Уважает `AHC_ACTOR_PROVIDER`. |
| `src/eval/baselines/mastra_om.ts:155` | `model: \`${providerId}/${modelId}\`` (composes OpenRouter ID) | Если provider=='google_direct', не префиксить; передавать чистый `gemini-3-flash-preview`. |
| `src/eval/adapters/tau-bench-retail/agent-runner.ts:39` | `TAU_ACTOR_FLASH_DEFAULT = 'google/gemini-3-flash-preview'` | То же — провайдер resolved через runtime env. |
| `package.json` | — | `+ "@ai-sdk/google": "^3.0.73"` (v6-compat, parallel to existing `@ai-sdk/{anthropic,openai}`). |
| `src/eval/llm.ts` (PRICING tables) | Только OpenRouter pricing | Добавить `GOOGLE_DIRECT_PRICING` table с актуальными Google AI Studio rates (verify через `https://ai.google.dev/pricing` перед launch). Особое: cached tokens 25% от base prompt rate — для honest cost-calc сплитим input на cached vs uncached. |
| `src/eval/types.ts` | `ConfigDef.provider` enum | + `'google_direct'` literal. |
| `eval/sweeps/main_e1_text_gemini.yaml` | (новый файл) | clone of `main_e1_text.yaml` + per-cell `provider: google_direct` override либо документировать `AHC_ACTOR_PROVIDER=google_direct` в pre-launch checklist. |

**Дополнительно:** Что мог бы изменить cache hit rate:
- **System prompt length** — implicit cache требует ≥1024 tok stable prefix для 2.5-flash;
  для 3-flash-preview probe показал hit @ 3630 tok. Если eval system_prompt короче —
  поднять до 1.5k-2k tok через legitimate boilerplate (как сделано в UI demo).
- **Placement** — для 3-flash prefix должен жить в `systemInstruction` (AI SDK
  `system:` param). Для 2.5-flash наоборот — в `contents` history (turn-0 user/model
  pair). Eval runners сейчас используют `system:` (через `createAhcRuntime` →
  `streamText({model, system, messages})`) — для 3-flash подходит, для 2.5 не оптимально.
- **TTL** — implicit cache evicts быстро (минуты), 8 turn'ов probe показал dip на
  turn 5/8 (один пропуск). Eval sweep с concurrency=10 — каждая ячейка может попасть
  в разный cache slot; metric поэтому будет shaky. Можно усреднить по seed=42+43.

**Cost / pricing impact.**
- gemini-3-flash-preview direct API: prompt $0.30/M, cached_prompt ~$0.075/M (25%),
  output $2.50/M (verify live).
- Если cache hit ratio = 56%, effective input cost = 0.56·$0.075 + 0.44·$0.30 = $0.174/M
  — ~42% дешевле OpenRouter ($0.30/M flat для Gemini-3-flash-preview через OR).
- Sweep cost expectation: H3-GD ≈ $5 vs H3-OR ≈ $8 на ту же matrix (cache-driven savings).

**Phase ordering.**
- H3.1 (adapter + runner extension + sweep file) — **prerequisite** для H3-GD.
- H3-OR можно launch'ить уже сейчас (status quo, no code change).
- H3-GD блокирован H3.1 (~ полдня adapter work + tests + smoke).
- Risk: если H3.1 не успеваем — H3-OR один альтернатив; F-report фиксирует cache-rate
  гap как provider-side limitation, не AHC weakness.

**Tests:**
- `src/adapters/ahc-runtime.test.ts` — new case `'google_direct'` returns wrapped LM.
- `src/eval/runner.test.ts` / `mastra_om.test.ts` — provider override env respected.
- Live mini-smoke: 1 task на AT через `google_direct` → records.ndjson
  `cache_read_input_tokens > 0` на step ≥ 2 (existing schema field per
  `src/eval/types.ts:Record`).

---

## 5. H4 — Multi-seed replication (seed=43)

### 5.1 Why

`design/E_main-runs.md §5.1` notes baked-subset seed effect is minimal на task selection (frozen seed=42 in subset_ids), но `temperature=0` decode не bit-deterministic — provider-side variance still surfaces. seed=43 quantifies this. F-report paired-permutation p-values pivot на `task_id`, не seed; но variance bar нужен для honest claim.

### 5.2 Command (gpt-5.4-mini)

```bash
sed -i.bak 's/seeds: \[42\]/seeds: [42, 43]/' eval/sweeps/main_e1_text.yaml
set -a && . ./.env && set +a
pnpm tsx scripts/eval.ts --sweep eval/sweeps/main_e1_text.yaml \
  --concurrency=10 --max-tasks-per-cell=20
```

NDJSON auto-resume: seed=42 cells остаются; только seed=43 cells run (12 new).

### 5.3 Optional cross-model seed=43

If H3 runs successfully, optionally run seed=43 on Gemini тоже (`main_e1_text_gemini.yaml` same edit). +$8.

### 5.4 Cost / wall-clock

- gpt-5.4-mini seed=43: ~$13 (single seed, 4 baselines, full anthropic_compact path).
- Optional Gemini seed=43: +$8.
- Total: $13–$21.
- Wall-clock: ~15-20 мин parallel.

### 5.5 Sanity replication gate

Для каждого (bench, baseline):
- accuracy(seed=43) within `2 × SEM` of accuracy(seed=42).
- IF outside → flag in audit, do NOT block commit (replicates F-report convention: report both, flag outliers).

---

## 6. H5 — Extended ablations on real subsets

### 6.1 Status check

`eval/sweeps/ablation_e2.yaml` already exists, 3 configs (`ahc_full`, `ahc_no_observer`, `ahc_no_offloader`) × 2 benches (AT, LME-med). `ahc_no_async_buffer` dropped в Phase D budget hedge.

### 6.2 Pre-launch

```bash
rm -rf benchmarks/runs/ablation_e2/    # pre-Phase-D dir if exists
# Verify YAML on real subsets — bench refs match baked-task layout from H1.
# (Phase D bakes already in place: longmemeval/tasks/lme_*.json × 120,
# assistant_traj/tasks/*.json × 30.)
```

### 6.3 Command

```bash
set -a && . ./.env && set +a
pnpm tsx scripts/eval.ts --sweep eval/sweeps/ablation_e2.yaml \
  --concurrency=10 --max-tasks-per-cell=20
```

If H4 ran first (seeds: [42, 43]) — apply same seed expansion before E2 launch:
`sed -i.bak 's/seeds: \[42\]/seeds: [42, 43]/' eval/sweeps/ablation_e2.yaml`.

### 6.4 Cost / wall-clock

- Single seed: 3 × 2 × n=20 = 6 cells × ~$0.5/cell = **~$3**.
- Both seeds: ~$6.
- Wall-clock: ~10–15 мин.

### 6.5 Sanity replication gate (§9 audit)

- `ahc_full` accuracy on (AT, LME-med) in E2 within `2 × SEM` of Phase D `ahc_full` accuracy on same benches.
- Per-component delta `(ahc_no_X - ahc_full)` accuracy: target > seed-spread floor (~2pp on n=20). Если < → flag «ablation power insufficient at n=20» в audit, recommend H5 → AT n=60 follow-up.

---

## 7. H6.1 — Tau-bench scale-up (n=10 → n=30)

### 7.1 Why

Phase D tau (post-grader-fix, commit `d9d1424`) n=10 produced AHC vs vanilla both ~0.1 — no separation. Need n≥30 для discrimination.

### 7.2 Pre-launch

Extend `references/mle-harness/results/taubench_episode_ids.json` to 30 indices (from upstream tau-bench retail tasks_test, 4 task families balanced). Re-bake:

```bash
source .venv-taubench/bin/activate
pnpm tsx scripts/bake-tau-bench.ts /Users/Aleksei/Projects/adaptive_hybrid_compaction/.venv-taubench/lib/python3.14/site-packages/tau_bench/envs/retail
python scripts/bake_tau_expected_states.py
```

### 7.3 Command

```bash
rm -rf benchmarks/runs/main_e1_tau/
set -a && . ./.env && set +a
pnpm tsx scripts/eval.ts --sweep eval/sweeps/main_e1_tau.yaml --concurrency=5
```

### 7.4 Cost / wall-clock

- 2 baselines × 30 ep × 2 seeds × ~$0.013/ep = **~$1.50**.
- Wall-clock: ~10 мин.

---

## 8. H6.2 — E3 cache-rate on real LongMemEval

### 8.1 Why

Phase D version of E3 ran on smoke fixtures (3 LME tasks ~200 tokens) — below Anthropic ephemeral cache 1024-token floor → `cache_read_input_tokens=0` measured. `system_design §2.1` ≥60% target requires real LME (~16k token avg) для honest verification.

### 8.2 Command

```bash
rm -rf benchmarks/runs/cache_hit_e3/
set -a && . ./.env && set +a
pnpm tsx scripts/eval.ts --sweep eval/sweeps/cache_hit_e3.yaml \
  --concurrency=5 --max-tasks-per-cell=20
```

### 8.3 Cost / wall-clock

- 2 cells (ahc_full_anthropic + anthropic_compact) × n=20 × Sonnet pricing via LITELLM ≈ **$5**.
- Wall-clock: ~10–15 мин.

### 8.4 Gate

Median `cache_read_input_tokens / total_input_tokens` per turn on `ahc_full_anthropic` ≥ 0.60 (`§2.1`). IF < → record honestly в `h_followup_audit.md`, не block.

---

## 9. H6.3 — AT per-class loss investigation (analysis-only)

### 9.1 Why

Phase D headline showed AHC -5pp на AT vs full_context (0.143 vs 0.190). Could be:
- (a) compaction info-loss on multi-turn AT (most likely → fixable via classifier tune).
- (b) classifier misroutes AT trajectories (→ fixable in `src/core/classifier.ts`).
- (c) image-modal asymmetry (FC passes images; AHC drops в Tier-2 summary).

### 9.2 Tool

`scripts/per-class-report.ts` already exists (Phase D). Usage:

```bash
pnpm tsx scripts/per-class-report.ts \
  benchmarks/runs/main_e1_text/assistant-traj/79f4236224fc1922/42/records.ndjson
# Replace config hash with ahc_full's; full_context cell под другим hash.
# Compare side-by-side; identify which class (code_iter / image_qa /
# research_write / mixed) драйвит AHC -5pp gap.
```

### 9.3 Output

Add `### AT Loss Per-Class` section to `h_followup_audit.md` с table:

| Class | n | full_context acc | ahc_full acc | Δ | Δ vs seed-floor |
|---|---|---|---|---|---|

Если image_qa драйвит — flag «AHC drops image content в Tier-2» как known issue в F-report appendix.

### 9.4 Cost

$0 (analysis only).

---

## 10. H6.4 — Mastra OM execution depth audit (analysis-only)

### 10.1 Why

S13 fix (`fbd2dcf`) wired Mastra OM to OpenRouter, но мы не подтвердили что OM thresholds actually fire on real LME haystack inputs (default trigger ~30k message tokens; LME haystack tasks have ~106k input). `mastra_om = full_context` accuracy tie on LME может означать:
- (i) OM никогда не triggered → equivalent to no-OM baseline.
- (ii) OM triggers but memory recall не помогает (Mastra impl limitation).

### 10.2 Approach

Add temporary debug hook в `src/eval/baselines/mastra_om.ts:buildMemoryOptions`:

```ts
observationalMemory: {
  model: resolveMastraModel(deps),
  onDebugEvent: (event) => {
    console.log(`[mastra:om] ${event.type} tokens=${event.pendingTokens}`)
  },
}
```

Re-run mastra_om × LME cells (~$0.50, 20 tasks):

```bash
rm -rf benchmarks/runs/main_e1_text/longmemeval-med/<mastra_om_hash>/
set -a && . ./.env && set +a
pnpm tsx scripts/eval.ts --sweep eval/sweeps/main_e1_text.yaml \
  --concurrency=5 --max-tasks-per-cell=20 \
  2>&1 | tee benchmarks/runs/main_e1_text/mastra_om_debug.log
grep "\[mastra:om\]" benchmarks/runs/main_e1_text/mastra_om_debug.log
```

If grep empty → OM never triggered (case i). If non-empty → OM ran, surface counts per task.

### 10.3 Output

Add «Mastra OM execution depth» row в `h_followup_audit.md`. Если case (i) — flag «mastra_om not exercising OM under our LME input shape» как honest caveat in F-report.

### 10.4 Cost

~$0.50.

---

## 11. Инварианты

### 11.1 Cross-model honesty

**Invariant:** Any sweep marketed as «cross-model» runs ALL baselines on the same target model. No asymmetric mix.

**How checked:** Pre-sweep cost-math probe (sample 1 record post-sweep across all baselines; assert `actor_cost / predicted_<target_model> ≈ 1.0` для каждого baseline'а). Sub-agent verification pattern from this conversation — standard recipe (see `memory/feedback_verify_code_state_before_sweep.md`).

### 11.2 Auto-resume safety

**Invariant:** Re-running a sweep после partial-halt не дублирует и не теряет records.

**How checked:** Existing `persist.ts:readCompletedTaskIds` test coverage; `design/E_main-runs.md §6` resume logic. Track H sweeps inherit this — no new mechanism.

### 11.3 Cache invariance preserved across env switches

**Invariant:** `pnpm test:cache-invariance` остаётся зелёным на любом значении `AHC_ACTOR_MODEL`.

**How checked:** Add `AHC_ACTOR_MODEL=foo` к verify.sh test matrix? — defer unless H1 surfaces regression.

---

## 12. Open questions

1. **`system_design §7` Track H scope row** — not yet added. Per `memory/feedback_phase_intro_doc_update.md`, when a plan introduces a new phase by name, the doc row lands as Step 0 of the same plan. Recommend: small PR (5-LOC system_design edit + this design doc) before launching H1. **Resolves when:** user approves H1 launch.
2. **Anthropic Cookbook memory tool vs LangChain SummaryBufferMemory** (§3.1) — pick which 2nd Anthropic competitor (if any). **Resolves when:** user picks or defers H2.
3. **Cross-model E2 ablations** — defer or include? Default deferred (cost ~$3 extra, may not be illustrative if H3 already shows cross-model delta dominates ablation effect). **Resolves when:** H3 cross-model headline numbers come in.
4. **AT n=30→60 via synthetic generation** (cf. old TODO #7, Phase D follow-up) — orthogonal to H but ablation power scales with n_AT. Track D continuation, not Track H. **Resolves when:** D3 design owner reactivates.
5. **Per-cell `actor_model` field in sweep YAML** — currently model resolved via env (global). Per-cell field would let one sweep mix models. Add only if cross-model interleaving becomes a recurring pattern. **Resolves when:** 2nd cross-model use-case emerges.

---

## 13. Spend budget summary

| Phase | Cost (USD) | Wall-clock |
|---|---|---|
| H1 infra | $0 | ~30 мин (code + tests) |
| H2 *(opt)* 2nd Anthropic baseline | $0 (code) + $0.50 (smoke) | ~2 ч |
| H3 cross-model main | $8 | ~15 мин |
| H4 multi-seed (gpt5.4-mini) | $13 | ~15 мин |
| H4-opt multi-seed (Gemini) | $8 | ~15 мин |
| H5 extended ablations | $3–6 | ~15 мин |
| H6.1 tau n=30 | $1.50 | ~10 мин |
| H6.2 E3 real LME | $5 | ~10 мин |
| H6.3 AT per-class | $0 | ~30 мин (analysis) |
| H6.4 mastra OM depth | $0.50 | ~30 мин (code + run) |
| **Total** | **$39.50–47.50** (+$8 if cross-model seed=43) | ~3 ч live; ~1.5 дня wall incl. analysis |

OpenRouter remaining ~$90 — comfortable headroom.
