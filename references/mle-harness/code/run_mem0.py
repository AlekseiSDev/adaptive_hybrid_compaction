"""Mem0 head-to-head on LongMemEval subset_A (seed=42, n=N).

For each item:
  1. Ingest haystack_sessions into Mem0 as user_id=question_id (capture ingest LLM cost).
  2. Search/retrieve memories for the question.
  3. Drive answer with Gemini-3-Flash via our LLMClient (recorded as mem0_answer experiment).
  4. Judge with gpt-4o-2024-08-06.
  5. Cache by (item_id, mem0_version) so re-run skips ingestion.

Writes mle/results/mem0_main.jsonl (rows: phase=ingest|answer + metrics).
"""
import asyncio, json, sys, os, time, hashlib
from pathlib import Path
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import argparse
import math, random
from collections import defaultdict, Counter
from datetime import datetime, timezone
import warnings; warnings.filterwarnings('ignore')

from llm_client import LLMClient, load_prices
from judge import judge_one
from run_main import stratified_sample


WORKDIR = Path('/workdir/compaction_policies__20260508_0231')
MLE = WORKDIR / 'mle'

DRIVER_SYSTEM = (
    "You are a helpful assistant. Use the user's stored memories below to answer "
    "the user's question. Be concise: respond with the direct answer in <=2 "
    "sentences. If the answer is not in the memories, say so."
)


def build_mem0(api_key, base_url='http://127.0.0.1:5091/v1', model='google/gemini-2.5-flash',
               qdrant_path='/tmp/qdrant_lme', qdrant_collection='lme_main'):
    os.environ['OPENAI_API_KEY'] = api_key
    os.environ['OPENAI_BASE_URL'] = base_url
    from mem0 import Memory
    cfg = {
        "llm": {"provider":"openai", "config":{
            "model": model, "openai_base_url": base_url, "api_key": api_key,
            "temperature": 0.0, "max_tokens": 1500,
        }},
        "embedder": {"provider":"huggingface", "config":{"model":"BAAI/bge-small-en-v1.5"}},
        "vector_store": {"provider":"qdrant", "config":{
            "collection_name": qdrant_collection, "embedding_model_dims": 384,
            "path": qdrant_path, "on_disk": False,
        }},
    }
    return Memory.from_config(cfg)


async def ingest_one(mem, item, *, ingest_cache, mem0_version):
    """Ingest haystack into Mem0. Returns (ingest_secs, n_msgs_ingested, used_cache)."""
    qid = item['question_id']
    cache_key = f"{qid}__{mem0_version}"
    if cache_key in ingest_cache:
        return (0.0, ingest_cache[cache_key]['n_msgs'], True)
    t0 = time.time()
    n_msgs = 0
    # Mem0 ingestion: feed entire conversation. We feed session-by-session so Mem0 can index incrementally.
    for sess in item['haystack_sessions']:
        msgs = []
        for turn in sess:
            role = turn['role']
            content = turn['content']
            msgs.append({'role': role, 'content': content})
        if msgs:
            try:
                mem.add(messages=msgs, user_id=qid)
                n_msgs += len(msgs)
            except Exception as e:
                # Continue on per-session errors
                print(f'  warn: mem0.add failed for {qid} sess: {e}')
    dt = time.time() - t0
    ingest_cache[cache_key] = {'n_msgs': n_msgs, 'ingest_secs': dt}
    return (dt, n_msgs, False)


async def query_one(mem, llm, item, *, mem0_version, top_k=20):
    """Search Mem0 for memories, drive answer with our LLMClient, judge."""
    qid = item['question_id']
    qtype = item['question_type']
    question = item['question']
    
    t0 = time.time()
    # search: collect top-K memories
    res = mem.search(query=question, filters={'user_id': qid}, version='v1.1', limit=top_k)
    memories = res.get('results', [])
    retrieve_secs = time.time() - t0

    # Build the memory string
    if not memories:
        mem_str = "(no memories retrieved)"
    else:
        lines = []
        for i, mres in enumerate(memories):
            txt = mres.get('memory', '')
            score = mres.get('score', 0)
            lines.append(f"- [{i+1}] (relevance={score:.2f}) {txt}")
        mem_str = "Retrieved memories:\n" + "\n".join(lines)

    # Drive answer
    msgs = [
        {'role':'system','content':DRIVER_SYSTEM},
        {'role':'user','content':f"{mem_str}\n\nQuestion: {question}"},
    ]
    res_drv = await llm.complete(
        model='google/gemini-3-flash-preview', messages=msgs,
        temperature=0.0, max_tokens=256,
        experiment='mem0_answer', item_id=qid, strategy='mem0', call_kind='driver',
    )
    response = res_drv.text.strip()

    # Judge
    abstention = '_abs' in qid
    label, judge_text = await judge_one(
        llm, task=qtype, question=question, answer=item['answer'],
        response=response, question_id=qid, abstention=abstention,
        judge_model='openai/gpt-4o-2024-08-06',
        experiment='mem0_answer', strategy='mem0',
    )
    return {
        'question_id': qid, 'question_type': qtype, 'strategy': 'mem0',
        'phase': 'answer', 'experiment': 'mem0_answer',
        'retrieve_secs': retrieve_secs, 'n_memories_used': len(memories),
        'memory_string_chars': len(mem_str),
        'driver_input_tokens': res_drv.prompt_tokens,
        'driver_output_tokens': res_drv.completion_tokens,
        'driver_latency_s': res_drv.latency_s,
        'driver_usd': res_drv.usd,
        'response': response, 'judge_label': bool(label), 'judge_raw': judge_text,
        'abstention': abstention,
    }


async def amain(args):
    load_prices(MLE / 'openrouter_prices_snapshot.json')
    with open(MLE / 'data/longmemeval/longmemeval_s.json') as f:
        items = json.load(f)
    
    if args.use_subset_A_ids:
        ids = json.load(open(MLE / 'results/subset_A_ids.json'))
        ids = ids[:args.n]
        by_id = {it['question_id']: it for it in items}
        subset_A = [by_id[i] for i in ids if i in by_id]
        print(f'subset_A from saved IDs[:{args.n}]: types={Counter(it["question_type"] for it in subset_A)}')
    else:
        subset_A = stratified_sample(items, args.n, seed=42)
        print(f'subset_A(seed=42, n={args.n}): types={Counter(it["question_type"] for it in subset_A)}')
    
    api_key = open('/tmp/openrouter_key.txt').read().strip()
    mem = build_mem0(api_key, base_url=args.base_url, model=args.model,
                     qdrant_path=args.qdrant_path, qdrant_collection=args.qdrant_collection)
    
    import mem0
    mem0_version = mem0.__version__
    print(f'mem0 version: {mem0_version}')
    
    ingest_cache_path = MLE / 'mem0_ingest_cache.json'
    ingest_cache = {}
    if ingest_cache_path.exists():
        with open(ingest_cache_path) as f:
            ingest_cache = json.load(f)
    
    out_path = MLE / 'results' / 'mem0_main.jsonl'
    if not args.append:
        out_path.unlink(missing_ok=True)
    out_f = open(out_path, 'a')
    
    llm = LLMClient(cache_dir=MLE/'cache', cost_log_path=MLE/'cost_log.jsonl', max_concurrency=4)
    
    proxy_cost_log = MLE / 'cost_log_proxy.jsonl'
    
    # Track mem0-only cost per item
    n_done = 0
    total_ingest_secs = 0
    total_retrieve_secs = 0
    
    # Process items sequentially (Mem0 stateful) but we can parallelize after ingestion
    print('--- Phase: Ingest ---')
    for i, it in enumerate(subset_A):
        qid = it['question_id']
        # Check budget
        if (i % 5 == 0) and i > 0:
            mem0_spend = 0.0
            if proxy_cost_log.exists():
                with open(proxy_cost_log) as f:
                    for line in f:
                        try:
                            row = json.loads(line)
                            mem0_spend += float(row.get('usd', 0))
                        except: pass
            print(f'  after {i} ingestions, mem0_proxy_spend=${mem0_spend:.4f}, '
                  f'total_ingest_secs={total_ingest_secs:.0f}')
            if mem0_spend > args.spend_halt_usd:
                print(f'HALT: mem0 ingest spend ${mem0_spend:.4f} > halt ${args.spend_halt_usd}')
                break
        try:
            dt, n_msgs, cached = await ingest_one(mem, it, ingest_cache=ingest_cache, mem0_version=mem0_version)
        except Exception as e:
            print(f'  ingest failed for {qid}: {e}')
            row = {'question_id': qid, 'phase':'ingest', 'error': repr(e)}
            out_f.write(json.dumps(row, default=str)+'\n'); out_f.flush()
            continue
        total_ingest_secs += dt
        row = {'question_id': qid, 'question_type': it['question_type'],
               'phase':'ingest', 'ingest_secs': dt, 'n_msgs_ingested': n_msgs,
               'cached': cached, 'mem0_version': mem0_version}
        out_f.write(json.dumps(row)+'\n'); out_f.flush()
        # Save cache periodically
        if i % 5 == 0:
            with open(ingest_cache_path, 'w') as f:
                json.dump(ingest_cache, f)
        n_done += 1
        print(f'  [{i+1}/{len(subset_A)}] ingested {qid}  msgs={n_msgs}  dt={dt:.1f}s  cached={cached}')
    # Final cache flush
    with open(ingest_cache_path, 'w') as f:
        json.dump(ingest_cache, f)
    
    print(f'\n--- Phase: Answer ---')
    # Only attempt to answer items we successfully ingested
    answered_ids = set()
    for it in subset_A:
        qid = it['question_id']
        if f"{qid}__{mem0_version}" in ingest_cache:
            answered_ids.add(qid)
    print(f'answering {len(answered_ids)} items')
    
    # Sequential to avoid Mem0 race conditions on the same Qdrant
    for it in subset_A:
        if it['question_id'] not in answered_ids:
            continue
        try:
            r = await query_one(mem, llm, it, mem0_version=mem0_version)
            r['mem0_version'] = mem0_version
            out_f.write(json.dumps(r, default=str)+'\n'); out_f.flush()
            total_retrieve_secs += r['retrieve_secs']
        except Exception as e:
            print(f'  query failed for {it["question_id"]}: {e}')
            row = {'question_id': it['question_id'], 'phase':'answer', 'error': repr(e)}
            out_f.write(json.dumps(row, default=str)+'\n'); out_f.flush()
    
    out_f.close()
    print(f'\ndone. ingest_secs={total_ingest_secs:.1f}, retrieve_secs={total_retrieve_secs:.1f}')


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--n', type=int, default=25)
    p.add_argument('--base-url', default='http://127.0.0.1:5091/v1')
    p.add_argument('--model', default='google/gemini-2.5-flash')
    p.add_argument('--qdrant-path', default='/tmp/qdrant_lme_main')
    p.add_argument('--qdrant-collection', default='lme_main')
    p.add_argument('--spend-halt-usd', type=float, default=8.0)
    p.add_argument('--append', action='store_true')
    p.add_argument('--use-subset-A-ids', action='store_true', default=False)
    args = p.parse_args()
    asyncio.run(amain(args))


if __name__ == '__main__':
    main()
