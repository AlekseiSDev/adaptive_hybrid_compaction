"""Compaction strategies.

Each strategy is `async def compact(...) -> CompactedHistory`:
- input: list[Segment] (the prior conversation history, *excluding* the live user query),
  the live user query string, a token budget, an LLMClient, and identifiers (experiment/item_id).
- output: CompactedHistory with the new (compacted) Segment list, original/compacted token
  counts, and an audit trail describing what was kept verbatim and what was summarised.

Five strategies implemented:
1. full_context     — passthrough.
2. naive_truncation — keep system + last-N-tokens.
3. rolling_summary  — task-AGNOSTIC chunk summaries (W=20 turns).
4. type_aware       — per-role budget allocator + type-specific policies.
5. task_aware       — single LLM call sees full history + live user query.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, Awaitable

from segments import Segment, total_tokens, count_tokens


# ---------------------------------------------------------------------------
# Container
# ---------------------------------------------------------------------------
@dataclass
class CompactedHistory:
    segments: list[Segment]
    original_tokens: int
    compacted_tokens: int
    strategy: str
    audit: dict = field(default_factory=dict)


# ---------------------------------------------------------------------------
# 1. full_context
# ---------------------------------------------------------------------------
async def compact_full_context(
    history: list[Segment],
    live_query: str,
    budget: int,
    llm,
    *,
    experiment: str,
    item_id: str,
    compactor_model: str,
) -> CompactedHistory:
    orig = total_tokens(history)
    return CompactedHistory(
        segments=list(history),
        original_tokens=orig,
        compacted_tokens=orig,
        strategy="full_context",
        audit={"note": "passthrough"},
    )


# ---------------------------------------------------------------------------
# 2. naive_truncation
# ---------------------------------------------------------------------------
async def compact_naive_truncation(
    history: list[Segment],
    live_query: str,
    budget: int,
    llm,
    *,
    experiment: str,
    item_id: str,
    compactor_model: str,
) -> CompactedHistory:
    orig = total_tokens(history)
    # Keep system messages always.
    sys_segs = [s for s in history if s.role == "system"]
    rest = [s for s in history if s.role != "system"]
    sys_tok = sum(s.tokens for s in sys_segs)
    avail = max(0, budget - sys_tok)

    # Walk from the end, accumulating until we hit the budget.
    kept_rev: list[Segment] = []
    cur = 0
    for s in reversed(rest):
        if cur + s.tokens > avail:
            break
        kept_rev.append(s)
        cur += s.tokens
    kept = list(reversed(kept_rev))
    n_dropped = len(rest) - len(kept)

    out: list[Segment] = list(sys_segs)
    if n_dropped > 0:
        marker = f"<<<earlier history truncated: {n_dropped} turns dropped>>>"
        out.append(Segment(role="user", content=marker, meta={"_marker": True}))
    out.extend(kept)

    return CompactedHistory(
        segments=out,
        original_tokens=orig,
        compacted_tokens=total_tokens(out),
        strategy="naive_truncation",
        audit={"dropped_turns": n_dropped, "kept_turns": len(kept), "budget": budget},
    )


# ---------------------------------------------------------------------------
# 3. rolling_summary  (task-agnostic)
# ---------------------------------------------------------------------------
ROLLING_PROMPT = (
    "Summarize the following conversation chunk in <=200 words, preserving all "
    "factual user statements, preferences, decisions, and unresolved questions. "
    "Do NOT include meta-commentary."
)


async def compact_rolling_summary(
    history: list[Segment],
    live_query: str,
    budget: int,
    llm,
    *,
    experiment: str,
    item_id: str,
    compactor_model: str,
    chunk_size: int = 20,
    keep_last_chunks: int = 2,
    max_summary_tokens: int = 220,
) -> CompactedHistory:
    """Walk history in chunks of W turns; summarise completed chunks; keep last K verbatim."""
    orig = total_tokens(history)
    # Carve into chunks. Treat each Segment as a turn (LongMemEval one-utterance-per-segment).
    chunks: list[list[Segment]] = []
    for i in range(0, len(history), chunk_size):
        chunks.append(history[i:i + chunk_size])
    if not chunks:
        return CompactedHistory([], 0, 0, "rolling_summary", {"note": "empty"})

    # Tail kept verbatim
    tail = chunks[-keep_last_chunks:]
    head = chunks[:-keep_last_chunks] if len(chunks) > keep_last_chunks else []

    new_segs: list[Segment] = []
    summaries_made = 0
    for c_idx, chunk in enumerate(head):
        chunk_text = _render_chunk(chunk)
        msgs = [
            {"role": "system", "content": ROLLING_PROMPT},
            {"role": "user", "content": chunk_text},
        ]
        res = await llm.complete(
            model=compactor_model, messages=msgs,
            temperature=0.0, max_tokens=max_summary_tokens,
            experiment=experiment, item_id=item_id,
            strategy="rolling_summary", call_kind="compactor",
        )
        summaries_made += 1
        new_segs.append(Segment(
            role="assistant_text",
            content=f"[summary chunk {c_idx} of {len(chunk)} turns] {res.text}",
            meta={"compactor": "rolling_summary", "chunk_idx": c_idx, "src_turns": len(chunk)},
        ))

    for c_idx, chunk in enumerate(tail, start=len(head)):
        new_segs.extend(chunk)

    return CompactedHistory(
        segments=new_segs,
        original_tokens=orig,
        compacted_tokens=total_tokens(new_segs),
        strategy="rolling_summary",
        audit={
            "n_chunks": len(chunks),
            "n_summarized": summaries_made,
            "n_tail_kept": sum(len(c) for c in tail),
            "chunk_size": chunk_size,
        },
    )


def _render_chunk(chunk: list[Segment]) -> str:
    lines = []
    for s in chunk:
        sid = s.meta.get("session_id", "?")
        tid = s.meta.get("turn_idx", "?")
        role = s.role
        lines.append(f"[{sid} t{tid} {role}] {s.content}")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# 4. type_aware  (PROPOSED)
# ---------------------------------------------------------------------------
TYPE_SHARES: dict[str, float] = {
    "system": 0.05,
    "user": 0.45,            # user messages carry ground-truth memory
    "assistant_text": 0.35,
    "assistant_reasoning": 0.05,
    "tool_call": 0.05,
    "tool_result": 0.05,
}


async def compact_type_aware(
    history: list[Segment],
    live_query: str,
    budget: int,
    llm,
    *,
    experiment: str,
    item_id: str,
    compactor_model: str,
    chunk_size: int = 20,
    keep_last_assistant_chunks: int = 1,
    max_summary_tokens: int = 220,
) -> CompactedHistory:
    """Per-role budget allocator + role-specific compression.

    Policy (LongMemEval reduction = system / user / assistant_text only):
      - system: always verbatim.
      - user: keep all verbatim if user_total <= residual; else fallback:
          keep most-recent user turns verbatim while sum <= 0.6 * budget,
          summarise older user turns into 1-line entries with timestamps.
          Logs every fallback.
      - assistant_text: chunk + rolling summarise to fit residual budget.
      - assistant_reasoning, tool_call: structured stub; keep last 3 verbatim.
      - tool_result: head+tail extract + 1-line LLM summary; keep last 3 verbatim.

    Slack rolls forward: each non-system type has a soft target share; unused
    slack rolls forward to subsequent types.
    """
    orig = total_tokens(history)

    by_role: dict[str, list[Segment]] = {}
    for s in history:
        by_role.setdefault(s.role, []).append(s)

    audit_alloc: dict = {}
    fallbacks: list[dict] = []
    final: list[Segment] = []

    # ------------------------------------------------------------------ system
    sys_segs = by_role.get("system", [])
    sys_used = sum(s.tokens for s in sys_segs)
    final.extend(sys_segs)
    audit_alloc["system"] = {"target": int(TYPE_SHARES["system"] * budget),
                             "used": sys_used, "kept": len(sys_segs),
                             "policy": "verbatim"}

    remaining = max(0, budget - sys_used)

    # ------------------------------------------------------------------ user
    user_segs = by_role.get("user", [])
    user_total = sum(s.tokens for s in user_segs)
    user_target = int(TYPE_SHARES["user"] * budget)

    user_kept_verbatim: list[Segment] = []
    user_summarised: list[Segment] = []
    if user_total <= remaining:
        user_kept_verbatim = list(user_segs)
        user_used = user_total
        user_policy = "all_verbatim"
    else:
        protect_cap = int(0.6 * budget)
        running = 0
        kept_rev: list[Segment] = []
        for s in reversed(user_segs):
            if running + s.tokens > protect_cap:
                break
            running += s.tokens
            kept_rev.append(s)
        user_kept_verbatim = list(reversed(kept_rev))
        kept_set = {id(s) for s in user_kept_verbatim}
        older = [s for s in user_segs if id(s) not in kept_set]
        if older:
            lines = []
            for s in older:
                date = s.meta.get("date") or "?"
                sid = s.meta.get("session_id", "?")
                tid = s.meta.get("turn_idx", "?")
                preview = s.content.replace("\n", " ").strip()[:300]
                lines.append(f"[{date} {sid} t{tid}] {preview}")
            joined = "\n".join(lines)
            msg = [
                {"role": "system", "content": (
                    "Compress each line into a 1-line bullet preserving entity, "
                    "date, and key fact. Output one bullet per input line, in order, "
                    "prefixed with the original [date sid tT] tag. No preface, no commentary."
                )},
                {"role": "user", "content": joined},
            ]
            res = await llm.complete(
                model=compactor_model, messages=msg,
                temperature=0.0, max_tokens=min(2000, max(400, len(older) * 25)),
                experiment=experiment, item_id=item_id,
                strategy="type_aware", call_kind="compactor",
            )
            user_summarised.append(Segment(
                role="user",
                content=f"[older user-turn summaries -- {len(older)} turns compressed]\n{res.text}",
                meta={"compactor": "type_aware/user_fallback", "src_turns": len(older)},
            ))
        fallbacks.append({
            "type": "user_overflow",
            "user_total": user_total,
            "remaining_budget": remaining,
            "kept_verbatim": len(user_kept_verbatim),
            "summarised": len(older) if older else 0,
        })
        user_used = total_tokens(user_kept_verbatim) + total_tokens(user_summarised)
        user_policy = "fallback_recent_verbatim_plus_1line"

    final.extend(user_kept_verbatim + user_summarised)
    remaining = max(0, remaining - user_used)
    audit_alloc["user"] = {"target": user_target, "used": user_used,
                           "kept_verbatim": len(user_kept_verbatim),
                           "summarised_blocks": len(user_summarised),
                           "policy": user_policy}

    # ------------------------------------------------------------------ assistant_text
    at_segs = by_role.get("assistant_text", [])
    at_total = sum(s.tokens for s in at_segs)
    at_target = int(TYPE_SHARES["assistant_text"] * budget)

    if not at_segs:
        audit_alloc["assistant_text"] = {"target": at_target, "used": 0, "kept": 0, "policy": "absent"}
    elif at_total <= remaining:
        final.extend(at_segs)
        remaining = max(0, remaining - at_total)
        audit_alloc["assistant_text"] = {"target": at_target, "used": at_total,
                                         "kept": len(at_segs),
                                         "policy": "verbatim_under_residual"}
    else:
        n = len(at_segs)
        tail_n = chunk_size * keep_last_assistant_chunks
        tail = at_segs[max(0, n - tail_n):]
        tail_tokens = total_tokens(tail)
        if tail_tokens >= remaining:
            head_segs = at_segs
            tail = []
            tail_tokens = 0
        else:
            head_segs = at_segs[:max(0, n - tail_n)]
        residual_for_summary = max(200, remaining - tail_tokens)
        n_chunks_target = max(1, residual_for_summary // max_summary_tokens)
        size = max(chunk_size, (len(head_segs) + n_chunks_target - 1) // max(1, n_chunks_target))
        chunks: list[list[Segment]] = []
        for i in range(0, len(head_segs), size):
            chunks.append(head_segs[i:i + size])
        per_chunk_cap = max(60, residual_for_summary // max(1, len(chunks)))
        per_chunk_cap = min(per_chunk_cap, max_summary_tokens)

        summed_segs: list[Segment] = []
        for ci, ch in enumerate(chunks):
            chunk_text = _render_chunk(ch)
            msgs = [
                {"role": "system", "content": ROLLING_PROMPT},
                {"role": "user", "content": chunk_text},
            ]
            res = await llm.complete(
                model=compactor_model, messages=msgs,
                temperature=0.0, max_tokens=per_chunk_cap,
                experiment=experiment, item_id=item_id,
                strategy="type_aware", call_kind="compactor",
            )
            summed_segs.append(Segment(
                role="assistant_text",
                content=f"[summary assistant chunk {ci} of {len(ch)} turns] {res.text}",
                meta={"compactor": "type_aware/rolling", "chunk_idx": ci, "src_turns": len(ch)},
            ))
        final.extend(summed_segs + tail)
        audit_alloc["assistant_text"] = {
            "target": at_target, "used": at_total,
            "kept_verbatim_tail": len(tail),
            "summarised_chunks": len(summed_segs),
            "per_chunk_cap_tokens": per_chunk_cap,
            "chunk_size_used": size,
            "policy": "rolling_over_residual",
        }

    # ------------------------------------------------------------------ tool_call / assistant_reasoning
    for role in ("tool_call", "assistant_reasoning"):
        segs = by_role.get(role, [])
        if not segs:
            continue
        keep = segs[-3:]
        squashed = []
        for s in segs[:-3]:
            stub = f"[{role} stub: tool={s.meta.get('tool_name','?')} arg_keys={list((s.meta.get('arg_keys') or []))}]"
            squashed.append(Segment(role=role, content=stub, meta={"compactor": "type_aware/stub"}))
        final.extend(squashed + keep)
        audit_alloc[role] = {"kept_tail_3": len(keep), "stubbed": len(segs) - len(keep), "policy": "stub_tail3"}

    # ------------------------------------------------------------------ tool_result
    tr_segs = by_role.get("tool_result", [])
    if tr_segs:
        keep = tr_segs[-3:]
        compressed = []
        for s in tr_segs[:-3]:
            head_chars = s.content[:200]
            tail_chars = s.content[-200:] if len(s.content) > 400 else ""
            msgs = [
                {"role": "system", "content": "Summarise this tool result in <=20 words. Output one line, no preface."},
                {"role": "user", "content": s.content[:4000]},
            ]
            res = await llm.complete(
                model=compactor_model, messages=msgs,
                temperature=0.0, max_tokens=64,
                experiment=experiment, item_id=item_id,
                strategy="type_aware", call_kind="compactor",
            )
            comp = f"[tool_result extract] head: {head_chars}\ntail: {tail_chars}\nsummary: {res.text.strip()}"
            compressed.append(Segment(role="tool_result", content=comp, meta={"compactor": "type_aware/extract"}))
        final.extend(compressed + keep)
        audit_alloc["tool_result"] = {"kept_tail_3": len(keep), "compressed": len(tr_segs) - len(keep), "policy": "head_tail_summary"}

    def _order_key(s: Segment) -> tuple:
        return (s.meta.get("session_idx", 0), s.meta.get("turn_idx", 0), 0)

    final_sorted = sorted(final, key=_order_key)

    return CompactedHistory(
        segments=final_sorted,
        original_tokens=orig,
        compacted_tokens=total_tokens(final_sorted),
        strategy="type_aware",
        audit={
            "allocation": audit_alloc,
            "budget": budget,
            "shares": TYPE_SHARES,
            "fallbacks": fallbacks,
        },
    )


# 5. task_aware  (PROPOSED)
# ---------------------------------------------------------------------------
TASK_AWARE_PROMPT_TEMPLATE = """You are compacting an agent's conversation history. The user is about to ask:
"{live_user_query}"

Reduce the history below to <={token_budget} tokens, with these rules:
1. Keep verbatim any prior message that is directly relevant to the live query (entity, fact, preference, or decision the user might be asking about).
2. Summarize the rest in dense bullet form. Use the format `[session-N, turn-T] <fact>` for each preserved fact.
3. Never invent. If unsure whether a fact is relevant, keep it verbatim.

History:
{history}"""


async def compact_task_aware(
    history: list[Segment],
    live_query: str,
    budget: int,
    llm,
    *,
    experiment: str,
    item_id: str,
    compactor_model: str,
    max_output_tokens: int = 4000,
    enable_thinking: bool = False,
) -> CompactedHistory:
    orig = total_tokens(history)
    rendered = _render_history_for_task_aware(history)
    prompt = TASK_AWARE_PROMPT_TEMPLATE.format(
        live_user_query=live_query,
        token_budget=budget,
        history=rendered,
    )
    msgs = [
        {"role": "system", "content": "You are an expert at compacting agent conversation histories."},
        {"role": "user", "content": prompt},
    ]
    extra: dict | None = None
    if enable_thinking:
        # Gemini-3-Flash thinking budget hint via OpenRouter passthrough.
        extra = {"reasoning": {"max_tokens": 1024}}
    res = await llm.complete(
        model=compactor_model, messages=msgs,
        temperature=0.0, max_tokens=max_output_tokens,
        experiment=experiment, item_id=item_id,
        strategy="task_aware", call_kind="compactor",
        extra=extra,
    )
    out_seg = Segment(
        role="assistant_text",
        content=f"[compacted history (task-aware), original={orig}t]\n{res.text}",
        meta={"compactor": "task_aware", "live_query": live_query[:200]},
    )
    return CompactedHistory(
        segments=[out_seg],
        original_tokens=orig,
        compacted_tokens=out_seg.tokens,
        strategy="task_aware",
        audit={
            "compactor_prompt_tokens": res.prompt_tokens,
            "compactor_completion_tokens": res.completion_tokens,
            "budget": budget,
            "thinking": enable_thinking,
            "compacted_text_preview": res.text[:2000],
        },
    )


def _render_history_for_task_aware(history: list[Segment]) -> str:
    lines = []
    for s in history:
        sid = s.meta.get("session_id", s.meta.get("session_idx", "?"))
        tid = s.meta.get("turn_idx", "?")
        lines.append(f"[session-{sid}, turn-{tid}, role-{s.role}] {s.content}")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------
STRATEGIES: dict[str, Callable[..., Awaitable[CompactedHistory]]] = {
    "full_context": compact_full_context,
    "naive_truncation": compact_naive_truncation,
    "rolling_summary": compact_rolling_summary,
    "type_aware": compact_type_aware,
    "task_aware": compact_task_aware,
}
