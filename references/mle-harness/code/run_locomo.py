"""LoCoMo small run: 25 items × 3 strategies × gemini-3-flash-preview.

Source dataset: Percena/locomo-mc10 (mirror of snap-research/locomo10).

Schema:
  - 10 conversations
  - Each has multi-session dialogue (~17.5k tokens), QA pairs with categories:
      1=single-hop, 2=multi-hop, 3=temporal, 4=open-domain, 5=adversarial
  - We sample 25 items stratified across cat 1..4 (skip 5 - adversarial)

For each (conversation, qa_pair):
  - Flatten conversation -> Segment list (alternating user/assistant_text by speaker)
  - Compact via {rolling_summary, type_aware, task_aware} @ budget=8000
  - Driver answer call with gemini-3-flash-preview
  - Judge with gpt-4o-2024-08-06 ("reasonable equivalence" prompt)

Outputs:
  mle/results/locomo_main.jsonl
  mle/results/locomo_summary.json
  mle/results/locomo_subset_ids.json
"""
from __future__ import annotations

import argparse
import asyncio
import json
import math
import random
import statistics
import sys
import time
from collections import defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
WORKDIR = HERE.parent  # mle/

from segments import Segment, total_tokens, count_tokens  # noqa: E402
from llm_client import LLMClient, load_prices  # noqa: E402
from compactors import STRATEGIES  # noqa: E402

DRIVER = "google/gemini-3-flash-preview"
JUDGE = "openai/gpt-4o-2024-08-06"

CAT_NAMES = {1: "single-hop", 2: "multi-hop", 3: "temporal", 4: "open-domain", 5: "adversarial"}

DRIVER_SYSTEM = (
    "You are a helpful assistant. Use the conversation history below to answer "
    "the user's question. Be concise: respond with the direct answer in <=2 "
    "sentences. If the answer is not in the history, say so."
)

# LoCoMo-style judge prompt: simpler 'reasonable equivalence' yes/no check.
LOCOMO_JUDGE_TPL = (
    "I will give you a question, a correct answer, and a response from a model. "
    "Please answer yes if the response matches the correct answer with reasonable "
    "equivalence allowed. The response is correct if it conveys the same factual "
    "content, even if the wording differs. Otherwise, answer no.\n\n"
    "Question: {q}\nCorrect Answer: {a}\nModel Response: {r}\n\n"
    "Is the model response correct? Answer yes or no only."
)


def conversation_to_segments(item: dict) -> list[Segment]:
    """Extract session_1, session_2, ... in order, flatten dialogue turns to Segments.
    Pass the FULL item (top-level dict with key 'conversation'), not the inner conv.
    speaker_a -> 'user', speaker_b -> 'assistant_text' (we have to pick one mapping).
    """
    conv = item.get("conversation", item)  # accept either
    segs: list[Segment] = []
    speaker_a = conv.get("speaker_a", "")
    # Find session_N keys in numeric order
    def _is_sess(k: str) -> bool:
        if not k.startswith("session_"):
            return False
        if k.endswith("date_time"):
            return False
        try:
            int(k.split("_")[1])
            return True
        except (ValueError, IndexError):
            return False
    sess_keys = sorted(
        [k for k in conv.keys() if _is_sess(k)],
        key=lambda k: int(k.split("_")[1]),
    )
    for s_idx, sk in enumerate(sess_keys):
        date = conv.get(f"{sk}_date_time", "")
        for t_idx, turn in enumerate(conv[sk]):
            speaker = turn.get("speaker", "")
            text = turn.get("text", "")
            role = "user" if speaker == speaker_a else "assistant_text"
            full = f"[{date}] {speaker}: {text}" if date else f"{speaker}: {text}"
            segs.append(
                Segment(
                    role=role,
                    content=full,
                    meta={
                        "session_idx": s_idx,
                        "session_id": sk,
                        "turn_idx": t_idx,
                        "speaker": speaker,
                        "date": date,
                        "dia_id": turn.get("dia_id", ""),
                    },
                )
            )
    return segs


def stratified_sample_qa(data: list[dict], n: int, seed: int = 42, exclude_categories: tuple = (5,)) -> list[dict]:
    """Pick n QA items stratified across categories, keeping (sample_id, qa_idx, qa)."""
    rng = random.Random(seed)
    by_cat = defaultdict(list)
    for c in data:
        for qi, q in enumerate(c["qa"]):
            cat = q.get("category", 0)
            if cat in exclude_categories:
                continue
            ans = q.get("answer", "")
            # Drop obviously broken / empty-answer items
            if ans is None or (isinstance(ans, str) and not ans.strip()):
                continue
            by_cat[cat].append({
                "sample_id": c["sample_id"],
                "qa_idx": qi,
                "category": cat,
                "category_name": CAT_NAMES.get(cat, str(cat)),
                "question": q["question"],
                "answer": str(ans),
                "evidence": q.get("evidence", []),
            })
    # equal-as-possible split
    cats = sorted(by_cat.keys())
    per = n // len(cats)
    extras = n - per * len(cats)
    out = []
    for ci, cat in enumerate(cats):
        take = per + (1 if ci < extras else 0)
        rng.shuffle(by_cat[cat])
        out.extend(by_cat[cat][:take])
    rng.shuffle(out)
    return out


async def judge_locomo(llm: LLMClient, *, q: str, a: str, r: str, item_id: str, strategy: str) -> tuple[bool, str]:
    prompt = LOCOMO_JUDGE_TPL.format(q=q, a=a, r=r)
    res = await llm.complete(
        model=JUDGE,
        messages=[{"role": "user", "content": prompt}],
        temperature=0.0,
        max_tokens=10,
        experiment="locomo",
        item_id=item_id,
        strategy=strategy,
        call_kind="judge",
    )
    text = res.text.lower().strip()
    label = text.startswith("yes")
    return label, res.text


async def run_one(
    *,
    conv_segments: list[Segment],
    item: dict,
    strategy: str,
    budget: int,
    llm: LLMClient,
) -> dict:
    fn = STRATEGIES[strategy]
    item_id = f"{item['sample_id']}_{item['qa_idx']}"
    cres = await fn(
        history=conv_segments,
        live_query=item["question"],
        budget=budget,
        llm=llm,
        experiment="locomo",
        item_id=item_id,
        compactor_model=DRIVER,
    )
    # Build driver chat
    msgs = [{"role": "system", "content": DRIVER_SYSTEM}]
    for s in cres.segments:
        msgs.append(s.to_chat())
    msgs.append({"role": "user", "content": item["question"]})
    t0 = time.time()
    dres = await llm.complete(
        model=DRIVER,
        messages=msgs,
        temperature=0.0,
        max_tokens=200,
        experiment="locomo",
        item_id=item_id,
        strategy=strategy,
        call_kind="driver",
    )
    dt = time.time() - t0
    label, judge_raw = await judge_locomo(
        llm,
        q=item["question"],
        a=item["answer"],
        r=dres.text,
        item_id=item_id,
        strategy=strategy,
    )
    return {
        "sample_id": item["sample_id"],
        "qa_idx": item["qa_idx"],
        "category": item["category"],
        "category_name": item["category_name"],
        "strategy": strategy,
        "question": item["question"],
        "answer": item["answer"],
        "response": dres.text,
        "judge_label": bool(label),
        "judge_raw": judge_raw,
        "compacted_tokens": cres.compacted_tokens,
        "original_tokens": cres.original_tokens,
        "driver_input_tokens": dres.prompt_tokens,
        "driver_output_tokens": dres.completion_tokens,
        "driver_usd": dres.usd,
        "driver_latency_s": dt,
    }


def wilson(k, n, z=1.96):
    if n == 0:
        return 0.0, 0.0
    p = k / n
    den = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / den
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / den
    return max(0.0, centre - half), min(1.0, centre + half)


async def main_async(args):
    load_prices(WORKDIR / "openrouter_prices_snapshot.json")
    llm = LLMClient(
        cache_dir=WORKDIR / "cache",
        cost_log_path=WORKDIR / "cost_log.jsonl",
        max_concurrency=4,
    )
    data = json.load(open(args.dataset))
    conv_by_sid = {c["sample_id"]: c for c in data}

    items = stratified_sample_qa(data, args.n, seed=args.seed)
    json.dump(items, open(WORKDIR / "results/locomo_subset_ids.json", "w"), indent=2)
    print(f"Sampled {len(items)} items across categories: "
          f"{dict((CAT_NAMES[c], sum(1 for it in items if it['category']==c)) for c in sorted(set(it['category'] for it in items)))}")

    # cache compacted Segment lists per sample_id (one conversation, used many times)
    # We cache via the LLMClient call cache already, since the compactor key is
    # (item_id, strategy, conversation contents). Conversation segments themselves
    # are reused across qa pairs for the same sample_id, but compactor calls keyed
    # on item_id (= sample_id_qa_idx) will always recompute the LLM call.
    seg_cache = {}

    out_path = WORKDIR / "results/locomo_main.jsonl"
    if not args.append:
        out_path.unlink(missing_ok=True)
    out_f = open(out_path, "a")

    strategies = [s.strip() for s in args.strategies.split(",") if s.strip()]
    halt_after = args.halt_after_usd

    n_done = 0
    n_total = len(items) * len(strategies)
    t_start = time.time()
    spent_at_start = _logged_spend(WORKDIR / "cost_log.jsonl")

    for it in items:
        sid = it["sample_id"]
        if sid not in seg_cache:
            seg_cache[sid] = conversation_to_segments(conv_by_sid[sid])
        segs = seg_cache[sid]
        for strat in strategies:
            try:
                row = await run_one(
                    conv_segments=segs,
                    item=it,
                    strategy=strat,
                    budget=args.budget,
                    llm=llm,
                )
                out_f.write(json.dumps(row, default=str) + "\n")
                out_f.flush()
                n_done += 1
                cur_total = _logged_spend(WORKDIR / "cost_log.jsonl")
                delta = cur_total - spent_at_start
                if n_done % 5 == 0 or n_done <= 6:
                    print(f"  [{n_done}/{n_total}] {sid}_{it['qa_idx']} {strat} judge={row['judge_label']} delta=${delta:.4f}")
                if halt_after > 0 and delta > halt_after:
                    print(f"HALT at delta=${delta:.4f} > ${halt_after}")
                    out_f.close()
                    return
            except Exception as e:
                print(f"  [{n_done}/{n_total}] {sid}_{it['qa_idx']} {strat} ERR {type(e).__name__}: {e}")
                out_f.write(json.dumps({"sample_id": sid, "qa_idx": it["qa_idx"], "strategy": strat, "error": repr(e)}) + "\n")
                out_f.flush()
    out_f.close()
    elapsed = time.time() - t_start
    print(f"Finished in {elapsed:.0f}s, delta spend=${_logged_spend(WORKDIR / 'cost_log.jsonl') - spent_at_start:.4f}")


def _logged_spend(path: Path) -> float:
    total = 0.0
    try:
        for line in open(path):
            r = json.loads(line)
            total += r.get("usd", 0) or 0
    except FileNotFoundError:
        return 0.0
    return total


def aggregate():
    rows = [json.loads(l) for l in open(WORKDIR / "results/locomo_main.jsonl") if l.strip() and "error" not in l]
    by_strat = defaultdict(list)
    for r in rows:
        by_strat[r["strategy"]].append(r)

    summary = {"per_strategy": {}, "per_strategy_per_type": {}}
    for s, rs in by_strat.items():
        n = len(rs)
        k = sum(1 for r in rs if r["judge_label"])
        lo, hi = wilson(k, n)
        summary["per_strategy"][s] = {
            "n": n,
            "accuracy": round(k / n, 4),
            "ci95_low": round(lo, 4),
            "ci95_high": round(hi, 4),
            "mean_compacted_tokens": round(sum(r["compacted_tokens"] for r in rs) / n, 1),
            "mean_driver_input_tokens": round(sum(r["driver_input_tokens"] for r in rs) / n, 1),
            "mean_driver_usd": round(sum(r["driver_usd"] for r in rs) / n, 6),
        }
        # per type
        per_t = defaultdict(list)
        for r in rs:
            per_t[r["category_name"]].append(r)
        summary["per_strategy_per_type"][s] = {}
        for t, lst in per_t.items():
            nn = len(lst)
            kk = sum(1 for r in lst if r["judge_label"])
            if nn >= 3:
                lo2, hi2 = wilson(kk, nn)
                summary["per_strategy_per_type"][s][t] = {
                    "n": nn,
                    "accuracy": round(kk / nn, 4),
                    "ci95_low": round(lo2, 4),
                    "ci95_high": round(hi2, 4),
                }
            else:
                summary["per_strategy_per_type"][s][t] = {"n": nn, "accuracy": round(kk / nn, 4) if nn else None}
    summary["n_total_rows"] = len(rows)
    json.dump(summary, open(WORKDIR / "results/locomo_summary.json", "w"), indent=2)
    print(json.dumps(summary, indent=2))


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--dataset", default=str(WORKDIR / "data/locomo/locomo10.json"))
    p.add_argument("--n", type=int, default=25)
    p.add_argument("--seed", type=int, default=42)
    p.add_argument("--budget", type=int, default=8000)
    p.add_argument("--strategies", default="rolling_summary,type_aware,task_aware")
    p.add_argument("--halt-after-usd", type=float, default=4.0)
    p.add_argument("--append", action="store_true")
    p.add_argument("--aggregate-only", action="store_true")
    args = p.parse_args()
    if args.aggregate_only:
        aggregate()
        return
    asyncio.run(main_async(args))
    aggregate()


if __name__ == "__main__":
    main()
