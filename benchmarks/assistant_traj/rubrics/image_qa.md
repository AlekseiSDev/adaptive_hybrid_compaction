# Rubric — image_qa

Image-grounded Q&A. The assistant is given a user question about an image
(chart, diagram, photo, illustration) and produces a textual answer. May be
multi-turn (follow-up questions, refinements, "look closer at X").

## Score 1.0 (perfect)

- Все фактические утверждения о содержимом изображения корректны.
- Ответ адресует конкретный вопрос пользователя; не уходит в сторону.
- Tone и detail level — assistant-style (не academic, не bullet-vomit,
  не overly hedged).
- Multi-turn: ответ согласован с историей — учитывает ранее обсуждённые
  constraints / observations.

## Score 0.5 (partial)

- Большинство фактов корректны, минорные неточности на периферийных деталях
  (counts off by 1, color hue mis-described, label slightly off).
- Адресует core question, но упускает 1+ sub-question.
- Tone close to assistant-style — слегка жёсткий или излишне длинный.
- Image-correctness не нарушается, completeness не 100%.

## Score 0.0 (fail)

- Hallucination главных фактов об изображении (counts wrong by orders,
  объекты не на картинке, structure wrong).
- Не отвечает на question.
- Reject'ит без justified reason ("I can't see images" когда attachment есть).
- Tone полностью off (agentic tool-call вместо human answer).

## Notes for the judge

- При наличии image attachment'а: используй его при оценке. Если результат
  визуально verifiable — проверяй буквально.
- Multi-turn: vопрос — самый последний user message; learn from prior turns
  но scoring — про финальный assistant reply, не про consistency.
- `expected_summary` — описание target answer, не verbatim; не требуй
  literal match.

## Judge prompt template

(Used by `src/eval/adapters/assistant-traj.judge.ts` when assembling the
judge call. Variables `{...}` are substituted in code.)

```
You are evaluating an assistant response per the rubric above (Score 1.0 /
0.5 / 0.0). Apply it strictly.

User question (final turn): {question}
Image attachments: {image_attachments}
Expected answer summary (ground truth, not verbatim): {expected_summary}
Assistant response: {response}

Output JSON only, no prose:
{"score": 0.0 | 0.5 | 1.0, "justification": "<≤2 sentences>"}
```
