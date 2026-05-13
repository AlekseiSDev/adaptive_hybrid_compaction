# Rubric — research_write

Research + free-form writing. The assistant produces longer-form content
(essay, report, summary, plan, document, protocol). Quality is structural +
factual + stylistic.

## Score 1.0 (perfect)

- Все required structural elements присутствуют (sections, headings, lists
  из expected_summary).
- Factual content корректен; источники / ссылки, если приведены, релевантны
  и не fabricated.
- Tone — formal / informal соответственно requested style; consistent
  throughout.
- Length appropriate — не truncated mid-thought, не padded.
- Sequential consistency across turn'ов сохранена (e.g. если в turn 3 user
  попросил добавить раздел "Качественный анализ", он есть в финальной версии).

## Score 0.5 (partial)

- Большинство structural elements есть, 1-2 пропущены или underdeveloped.
- Factual content в основном correct, минорные inaccuracies на peripheral
  деталях.
- Tone в целом правильный.
- Один из ранее обсуждённых элементов потерян / не synthesized в финал.

## Score 0.0 (fail)

- Major structural elements отсутствуют (e.g. user asked for 5 sections,
  got 2).
- Hallucinated facts / fabricated citations (Семаго Н.Я. (2099), вымышленные
  ISBNs, несуществующие законы).
- Wrong tone (assistant-academic vs. requested casual blog; informal vs.
  formal protocol).
- Полный non-sequitur — игнорирует last user instruction.

## Notes for the judge

- `expected_summary` детализирует target structure + key content points;
  читай внимательно — strict structural compliance важнее verbatim word match.
- Language consistency: соответствует ли язык ответа language of the
  conversation? Mismatch — penalty но не automatic fail unless rubric
  упоминает.
- Citations: проверь plausibility (известный автор + правдоподобный год),
  не enforce'ить link-validity.

## Judge prompt template

```
You are evaluating an assistant response per the rubric above (Score 1.0 /
0.5 / 0.0). Apply it strictly.

User instruction (final turn): {question}
Expected document summary (ground truth, structural + content points):
{expected_summary}
Assistant response: {response}

Output JSON only, no prose:
{"score": 0.0 | 0.5 | 1.0, "justification": "<≤2 sentences>"}
```
