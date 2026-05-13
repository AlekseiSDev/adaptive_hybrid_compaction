# Rubric — mixed

Mixed assistant flow — composite tasks crossing categories (e.g. image
description → code generation, research → tabular export, conceptual Q&A →
CSV). No single domain dominates; per-task evaluation strategy.

## Score 1.0 (perfect)

- Финальный output матчит требование последнего user turn буквально (если
  strict format — CSV / JSON / Markdown table / Mermaid block) или
  semantically (если free-form).
- Соблюдены ВСЕ explicit constraints from последнего user message:
  «with quoted fields», «12 rows», «sorted alphabetically», «no markdown
  around CSV», и т.п.
- Сохранён контекст предыдущих turn'ов — referenced entities / numbers /
  decisions consistent с прошлым (если в turn 4 решили 12 объектов, в
  финальной таблице их 12, не 11 и не 13).

## Score 0.5 (partial)

- Format mostly correct (e.g. CSV present, 1 row malformed; table present,
  1 column missing; correct count минус 1).
- Major requirement satisfied, минорное constraint missed.
- Один из earlier turn elements не reflected в финале.

## Score 0.0 (fail)

- Output format нарушает strict requirement (e.g. user asked CSV — got JSON;
  asked plain text — got rich markdown).
- Игнорирует last user instruction core.
- Внутреннее противоречие или major factual error.
- Hallucinates entities (если user перечислил 12, финал имеет лишние/wrong).

## Notes for the judge

- mixed tasks часто используют composite evaluation (regex + judge); regex
  sub-rules покрывают surface format (CSV header line, quote chars, row
  count). Твоя задача — content + intent + consistency.
- `expected_summary` — best ground truth; читай детально, особенно format
  specifics (количество rows / columns / quoted fields / sort order /
  allowed orderings).
- Если задача multi-modal (image earlier turn → text later) — проверь что
  earlier-turn observations не fabricated в финале.

## Judge prompt template

```
You are evaluating an assistant response per the rubric above (Score 1.0 /
0.5 / 0.0). Apply it strictly.

User instruction (final turn): {question}
Image attachments: {image_attachments}
Expected output summary (ground truth, format + content): {expected_summary}
Assistant response: {response}

Output JSON only, no prose:
{"score": 0.0 | 0.5 | 1.0, "justification": "<≤2 sentences>"}
```
