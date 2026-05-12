# Per-question-type accuracy (5 strategies x 6 question types)

**N = 120 (seed=42), budget = 8000 tokens**

| qtype | n | full_context | naive_truncation | rolling_summary | type_aware | task_aware |
|---|---|---|---|---|---|---|
| knowledge-update | 19 | 0.842 | 0.316 | 0.842 | 0.684 | 0.842 |
| multi-session | 32 | 0.594 | 0.125 | 0.375 | 0.375 | 0.656 |
| single-session-assistant | 13 | 1.000 | 0.538 | 0.615 | 0.538 | 0.923 |
| single-session-preference | 7 | 0.286 | 0.000 | 0.571 | 0.286 | 0.857 |
| single-session-user | 17 | 0.941 | 0.176 | 0.882 | 0.706 | 1.000 |
| temporal-reasoning | 32 | 0.375 | 0.062 | 0.375 | 0.281 | 0.500 |