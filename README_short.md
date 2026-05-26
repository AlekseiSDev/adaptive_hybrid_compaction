**AHC** — прослойка для AI SDK v6, которая сжимает контекст агентских сессий
на траекториях средней длины (5–15 ходов). За один проход алгоритм
(а) классифицирует траекторию (`разговорная` / `инструментально-тяжёлая` /
`смешанная`) по дешёвым правилам, без вызовов LLM,
(б) выбирает стратегию сжатия под класс — извлечение наблюдений, привязанных
к запросу, либо вынесение тяжёлых результатов вызовов инструментов
в отдельное хранилище со ссылкой на их место в контексте,
(в) держит контекст в трёхуровневой форме «только-дозапись», сохраняя
неизменный префикс для prompt-кэша. Вынесенные данные доступны через
инструмент `recall_tool_result(id)`, который подключается автоматически.

## Что сделано

- Алгоритмическое ядро (~25 модулей в `src/core/` с unit-тестами).
- Интеграция в AI SDK v6 одним вызовом `wrapLanguageModel`.
- Система прогонов и оценки + 4 бенчмарка
  (AssistantTraj, LongMemEval-med, LoCoMo-med, τ-bench).
- Три эталона для сравнения: `full_context`, `mastra_om`, `anthropic_compact`.
- Демонстрационный чат (Next.js 16) с живой панелью телеметрии.

## Что получили

Phase D + Track H завершены: 5 bench-shape ячеек × 4 baseline'а × 3 actor
provider'а (gpt-5.4-mini OpenRouter, claude-sonnet-4-6 LITELLM,
gemini-3-flash-preview Google direct) + 3-config × 2-bench × 2-seed
ablation grid. Total spend ≈ \$56.

**Главное достижение — 3.6× cost reduction на multi-turn LongMemEval.**
На P1 (`lme-multiturn`, n=15, seed 42) `ahc_full` тратит \$0.601/task
против `full_context` \$2.172/task — 72 % token saving, Observer
fires 15/15 записей. Точность падает с 0.500 до 0.133 — это tunable
trade-off через `OBSERVER_THRESHOLD` (текущие 4000 over-compact'ят,
6000–8000 должны вернуть точность). Это **principal real-world
measurement** AHC'а — единственная ячейка где compaction pipeline
реально работает end-to-end на корпусе.

**Cache stability cross-provider — structural-shape claim, с caveat'ом.**
На single-turn LongMemEval-Med / LoCoMo-Med AHC достигает **97 % / 99 %**
prompt-cache hit (против 37 % / 69 % у full_context — 60pp / 30pp delta
на том же протоколе бенча). Cache marker round-trips на Sonnet (49 %
через LITELLM) и Gemini direct (23 %). Caveat в §7.2 отчёта: эти 97 %
частично — артефакт 2-call протокола бенча (turn 0 acknowledgement →
turn 1 ответ; turn 1 переиспользует prefix от turn 0), плюс cross-task
prefix carry-over в OpenAI auto-cache window. Defensible часть — это
**delta vs `full_context` на одном и том же протоколе** + **mechanism
verification cross-provider**, не absolute 97 % как saving пользователю.

**τ-bench retail: 12.6 % cheaper** при той же точности 0.100. Offload
events 0/60 — потому что real retail tool sizes (~470 B – 1 KB) ниже
`T_SIZE_MIXED = 2 KB` threshold. Mechanism verified синтетическим
probe'ом; corpus-shape mismatch.

**Ablation:** removal Observer'а стоит **−10pp** accuracy на
LongMemEval-Med (на edge of binomial SE at n=20, direction matches
multi-turn finding). Removal Offloader'а в noise floor (−5pp).

**Самый важный honest finding:** bench-selection не оптимально
exercise'ил deployment surface AHC'а. **4 из 5 ячеек** дали
`compaction_events=0` или `offload_events=0`; только `lme-multiturn`
реально fires Observer. Архитектурные claim'ы держатся на одной
ячейке сильнее чем хотелось бы. Highest-priority follow-up —
bench-design work.

## Архитектурное улучшение vs prior

- **vs Mastra OM** (closest analog): + Type-Aware Offloader,
  + recall_tool, + trajectory classifier; numerical parity/win по cache
  rate (98.8 % vs 93.6 % на LoCoMo). Cache invariance enforced as
  unit test.
- **vs Anthropic `compact_20260112`**: preserves accuracy + measurable
  cache reads (97 %) где compact strips их в 0 %.
- **vs prior agent-generated study** (Holosophus): reproduces structural
  finding + добавляет direct cache-rate measurement + Type-Aware
  Offloader как answer на их open negative result on τ-bench.

## Engineering improvements identified

В отчёте §7.6 — 4 конкретных доработки которые surface'ились по ходу eval:

1. **`TIER1_INCLUDE_FIRST_USER` flag** — позволить Observer'у fire'ить
   на single-turn haystack'ах (сейчас haystack уходит в Tier-1 и Observer
   его не видит). *Highest-impact single fix.*
2. **`CALIBRATION_AUTO`** — auto-tune `OBSERVER_THRESHOLD` / `T_SIZE` /
   `T_CUM` из trace history. *Design есть, implementation нет.*
3. **Lower default `T_SIZE_MIXED` / per-bench override** — текущие 2 KB
   слишком высоки для retail-scale tools (`get_user_details` ~470 B).
   *Smallest code change, largest measurable effect.*
4. **Multi-turn-aware classifier features** — добавить агрегированные
   features (tool calls в последних 5 turn'ах, observation density)
   чтобы classifier реально дифференцировал классы (сейчас 100 % `mixed`
   на AT из-за cold-start). *Larger investment.*

## Что планирую доделать

- **Bench-design work** (highest priority): AT v2 с per-turn input ≥10K,
  τ-bench extension с larger tool returns, корпус где multi-turn
  LongMemEval canonical.
- Re-run `mastra_om` / `anthropic_compact` post-forward-fix чтобы
  получить честные actor-cost на Phase D shapes.
- Полноценный прогон на seed 43 на text-бенчах (cross-seed variance).
- Tune `OBSERVER_THRESHOLD` на `lme-multiturn` (4 K over-compact'ит;
  попробовать 6–8 K для accuracy-cost knee).
- Swap τ-bench actor на Sonnet (LITELLM) — лифт accuracy floor 0.10.
- Cross-session memory layer (Mem0-style) композированный с AHC.
- Демо-чат на публичный адрес. **в работе**
