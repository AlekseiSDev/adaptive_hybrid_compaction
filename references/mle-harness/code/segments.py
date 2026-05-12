"""Segment schema shared across LongMemEval (chat) and tool-call agent traces.

Designed so the same compaction modules work on both surfaces:
- LongMemEval flattens each haystack-session turn into (user, assistant_text) Segments.
- Future tau-bench/AppWorld will add tool_call / tool_result / assistant_reasoning Segments.
"""
from __future__ import annotations

from dataclasses import dataclass, field, asdict
from typing import Literal, Iterable
import tiktoken

Role = Literal[
    "system",
    "user",
    "assistant_text",
    "assistant_reasoning",
    "tool_call",
    "tool_result",
]

# Single shared encoder; cl100k_base is a stable, well-known token model
# (we treat token counts as approximate-but-consistent across all strategies).
_ENC = tiktoken.get_encoding("cl100k_base")


def count_tokens(text: str) -> int:
    if not text:
        return 0
    return len(_ENC.encode(text, disallowed_special=()))


@dataclass
class Segment:
    role: Role
    content: str
    meta: dict = field(default_factory=dict)
    tokens: int = 0

    def __post_init__(self) -> None:
        if self.tokens == 0 and self.content:
            self.tokens = count_tokens(self.content)

    def to_chat(self) -> dict:
        """Project to OpenAI-style chat message for the *driver* (final answer call)."""
        if self.role in ("assistant_text", "assistant_reasoning"):
            return {"role": "assistant", "content": self.content}
        if self.role == "tool_call":
            return {"role": "assistant", "content": f"[tool_call:{self.meta.get('tool_name','?')}] {self.content}"}
        if self.role == "tool_result":
            return {"role": "user", "content": f"[tool_result] {self.content}"}
        # system, user
        return {"role": self.role, "content": self.content}

    def to_dict(self) -> dict:
        return asdict(self)


def total_tokens(segs: Iterable[Segment]) -> int:
    return sum(s.tokens for s in segs)


def flatten_longmemeval_history(
    haystack_sessions: list[list[dict]],
    haystack_session_ids: list[str] | None = None,
    haystack_dates: list[str] | None = None,
) -> list[Segment]:
    """Flatten LongMemEval's list-of-sessions into a single Segment list.

    Each turn becomes one Segment. Role is mapped:
      - 'user' -> 'user'
      - 'assistant' -> 'assistant_text'
    Meta carries (session_idx, session_id, turn_idx, date, has_answer).
    """
    out: list[Segment] = []
    for s_idx, sess in enumerate(haystack_sessions):
        sid = haystack_session_ids[s_idx] if haystack_session_ids else f"sess_{s_idx}"
        date = haystack_dates[s_idx] if haystack_dates else None
        for t_idx, turn in enumerate(sess):
            role = turn["role"]
            mapped: Role = "user" if role == "user" else "assistant_text"
            out.append(
                Segment(
                    role=mapped,
                    content=turn["content"],
                    meta={
                        "session_idx": s_idx,
                        "session_id": sid,
                        "turn_idx": t_idx,
                        "date": date,
                        "has_answer": bool(turn.get("has_answer")),
                    },
                )
            )
    return out
