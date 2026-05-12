# AHC — Adaptive Hybrid Compaction

Middleware для context compaction агентских ассистентских систем на medium-distance
траекториях (5–15 turns). Гибрид task-aware и type-aware policies поверх 3-tier
append-only shape, с lightweight trajectory classifier для routing.

> **Статус:** дизайн-фаза. Кода пока нет — есть подробная спецификация и план реализации.

---

## Что это и зачем

На medium-distance траекториях ассистентов с tool-use существующие подходы к компакции
проигрывают по одному из критериев:

- **Mem0 / Letta / Zep** — оптимизированы под cross-session memory, избыточны на одной сессии.
- **LLMLingua / rolling-window** — не учитывают структуру (atomic tool_use/tool_result пары, query-relevance).
- **Native provider compaction** (Anthropic `compact_20260112`) — теряет tool outputs.

AHC адаптивно выбирает политику под класс траектории (`conversational | tool_heavy | mixed`)
и сохраняет cache-invariant prefix by construction.

## Цели проекта

Учебное проектное MVP для NLP-курса. Если пробьём целевые метрики — кандидат на:

- интеграцию в прод (2D-canvas ассистент в работе автора),
- публикацию paper'а как расширение существующего research (Borderline Accept, n=170).

## Ключевые свойства

- **Robustness across classes** — не разваливается на любом trajectory class.
- **Cost–quality Pareto** — доминирует ≥ 1 baseline по (accuracy × $/task) на каждом бенче.
- **Cache-friendly** — prompt-cache hit rate ≥ 60% на medium-traj.
- **AI SDK v6 совместимость** — работает как middleware над Agent class без модификации пользовательского кода.
- **Zero-config** — defaults работают из коробки, калибровка opt-in.

## Документация

| Документ | О чём |
|---|---|
| [`docs/system_design.md`](docs/system_design.md) | Цели, scope, архитектура, eval-protocol, план реализации |
| [`docs/design/A_ahc-algorithm.md`](docs/design/A_ahc-algorithm.md) | Алгоритмическое ядро: модули, контракты, pseudocode, инварианты |
| [`docs/ai-native-practices.md`](docs/ai-native-practices.md) | Практики организации репо под кодинг-агентов (referенс для структуры проекта) |

## Структура репозитория

```
src/{core,adapters,eval,ui}/         # код (Tracks A, A6, B+C, G)
eval/sweeps/                         # sweep configs (E)
benchmarks/{assistant_traj,runs}/    # custom bench (D) + run output (E)
observability/                       # Langfuse stack (B2, opt-in)
references/                          # vendored upstream snapshot (read-only)
scripts/                             # verify.sh + helpers
docs/                                # design (`design/`) + per-phase plans (`implementation/`) + decisions
report/                              # final PDF (F)
```

Canonical layout, dependency rule, track ownership — [`docs/system_design.md §11.6`](docs/system_design.md).

## Roadmap (high-level)

4 трека идут параллельно, ~4 недели wall-clock:

- **A. Core** — 3-tier shape, Type-Aware Offloader, Task-Aware Observer, Classifier, Async Buffer, AI SDK v6 adapter.
- **B. Eval harness** — telemetry, per-class breakdown, расширение существующего harness'а.
- **C. Baselines** — Mastra OM (main competitor), Anthropic native compact, full context.
- **D. Custom benchmark** — AssistantTraj (multimodal ассистентские трассы, ~30–40 задач).

Детали и milestones — в `docs/system_design.md §7`.

## Бенчмарки

| Бенчмарк | Фокус | n |
|---|---|---|
| LongMemEval-Medium | Conversational long-term memory | 60 + 30 replication |
| LoCoMo-Medium | Conversational temporal | 20 |
| τ-bench retail | Tool-heavy агентский | 25 |
| AssistantTraj (новый) | Multimodal ассистентский | 30–40 |

---

**Автор:** Aleksei Stepin
