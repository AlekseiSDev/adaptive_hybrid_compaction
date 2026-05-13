# Rubric — code_iter

Code generation with iterative refinement. The assistant produces or modifies
code; over multi-turn arc may run into errors, fix, retry, satisfy edge cases,
adapt to changing constraints.

## Score 1.0 (perfect)

- Код syntactically valid; structurally матчит intent последнего user request.
- Включает все необходимые edge cases / error handling, требуемые задачей.
- Сохраняет контекст предыдущих iterations (не теряет ранее обсуждённые
  constraints / API names / variable conventions).
- Pure code answers, без unnecessary prose; brief explanation OK if user
  asked or если changes non-obvious.

## Score 0.5 (partial)

- Код runs (или явно ran бы), но упускает 1-2 mentioned constraint.
- Есть мелкие style / naming issues, не влияющие на correctness.
- Tone близок к assistant-style; minor verbosity OK.
- Edge case missing, но happy-path correct.

## Score 0.0 (fail)

- Syntactically broken / wouldn't run.
- Структурно неверный подход (recursion when iterative was required;
  wrong data structure).
- Игнорирует core requirement from последнего user turn.
- Длинная prose без code когда user asked code.
- Hallucinates API / library calls (несуществующие methods, wrong signatures).

## Notes for the judge

- code_iter обычно использует composite evaluation: regex sub-rules уже
  проверили surface patterns (specific function names, return types,
  language tokens). Твоя задача — intent + correctness; не повторяй
  regex checks.
- `expected_summary` описывает target код semantically, не verbatim. Стиль
  / variable names могут отличаться.
- Multi-turn: при оценке учитывай контракты заявленные в ранних turn'ах
  (e.g. "use only standard library" в turn 2 → no external deps в turn 7).

## Judge prompt template

```
You are evaluating an assistant response per the rubric above (Score 1.0 /
0.5 / 0.0). Apply it strictly.

User instruction (final turn): {question}
Expected behavior summary (ground truth, semantic): {expected_summary}
Assistant response: {response}

Output JSON only, no prose:
{"score": 0.0 | 0.5 | 1.0, "justification": "<≤2 sentences>"}
```
