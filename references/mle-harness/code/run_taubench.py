"""tau-bench Phase 2: 25 retail episodes × 3 strategies (rolling_summary, type_aware, task_aware).

We replicate ToolCallingAgent.solve() but insert our compactor between
the message-history accumulator and the LLM call.

Driver: google/gemini-3-flash-preview via litellm -> openrouter base_url.
User simulator: openai/gpt-4o-mini via the same proxy.

Metric: pass@1 (env reward). Also: mean turns, mean tool_calls, mean USD/episode.
"""
from __future__ import annotations
import asyncio, json, os, sys, time, random
from pathlib import Path
from collections import Counter, defaultdict
from typing import Any, Dict, List

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
WORKDIR = HERE.parent  # mle/

# Configure litellm BEFORE tau_bench imports it.
os.environ['OPENAI_API_KEY'] = open('/tmp/openrouter_key.txt').read().strip()
os.environ['OPENAI_BASE_URL'] = 'http://127.0.0.1:5090/v1'
os.environ.setdefault('LITELLM_LOG', 'WARNING')

from tau_bench.envs import get_env
from tau_bench.agents.tool_calling_agent import (
    RESPOND_ACTION_NAME, message_to_action,
)
from litellm import completion

from segments import Segment, count_tokens, total_tokens
from compactors import STRATEGIES
from llm_client import LLMClient, load_prices, usd_for


# -----------------------------------------------------------------------------
# Convert tau-bench message history -> our Segment list
def messages_to_segments(messages: List[Dict[str, Any]]) -> List[Segment]:
    """tau-bench messages: [{role, content, tool_calls?}, {role:'tool', name, content}, ...]

    role mapping:
      system -> system
      user -> user (this is the user simulator's reply)
      assistant (with tool_calls) -> tool_call (one Segment per tool_call)
      assistant (with content, no tool_calls) -> assistant_text
      tool -> tool_result
    """
    segs: List[Segment] = []
    for i, m in enumerate(messages):
        role = m.get('role', '')
        content = m.get('content') or ''
        if role == 'system':
            segs.append(Segment(role='system', content=content,
                                 meta={'turn_idx': i, 'session_idx': 0}))
        elif role == 'user':
            segs.append(Segment(role='user', content=content,
                                 meta={'turn_idx': i, 'session_idx': 0}))
        elif role == 'assistant':
            tcs = m.get('tool_calls') or []
            if tcs:
                for tj, tc in enumerate(tcs):
                    fn = (tc.get('function') or {})
                    name = fn.get('name', '?')
                    args = fn.get('arguments', '')
                    seg = Segment(
                        role='tool_call',
                        content=f"[tool_call] {name}({args})",
                        meta={'turn_idx': i, 'session_idx': 0,
                              'tool_name': name, 'arg_keys': list((args if isinstance(args, dict) else {}).keys())},
                    )
                    segs.append(seg)
            else:
                if content:
                    segs.append(Segment(role='assistant_text', content=content,
                                         meta={'turn_idx': i, 'session_idx': 0}))
        elif role == 'tool':
            name = m.get('name', '?')
            segs.append(Segment(
                role='tool_result',
                content=str(content),
                meta={'turn_idx': i, 'session_idx': 0, 'tool_name': name},
            ))
        else:
            # Skip unknown roles
            pass
    return segs


def segments_to_chat_messages(segments: List[Segment]) -> List[Dict[str, Any]]:
    """Convert a compacted Segment list back to a flat chat-completion message list.
    Tool_call/tool_result get merged into compact text representations
    (our compaction collapses them anyway)."""
    out: List[Dict[str, Any]] = []
    for s in segments:
        if s.role == 'system':
            out.append({'role': 'system', 'content': s.content})
        elif s.role == 'user':
            out.append({'role': 'user', 'content': s.content})
        elif s.role == 'assistant_text':
            out.append({'role': 'assistant', 'content': s.content})
        elif s.role == 'assistant_reasoning':
            out.append({'role': 'assistant', 'content': f"[reasoning] {s.content}"})
        elif s.role == 'tool_call':
            # collapse to text turn since the orchestrator no longer needs to dispatch
            out.append({'role': 'assistant', 'content': s.content})
        elif s.role == 'tool_result':
            out.append({'role': 'user', 'content': f"[tool_result] {s.content}"})
        else:
            out.append({'role': 'user', 'content': str(s.content)})
    return out


# -----------------------------------------------------------------------------
# Compactor wrapper. We feed our async compactor an LLMClient that hits 5090.
async def compact_messages(messages, *, strategy, budget, llm, episode_id, ep_step):
    segs = messages_to_segments(messages)
    # Live query is the most recent user message (or the first instruction)
    live_query = ''
    for m in reversed(messages):
        if m.get('role') == 'user' and m.get('content'):
            live_query = m['content']
            break
    fn = STRATEGIES[strategy]
    res = await fn(
        history=segs[:-1] if segs and segs[-1].role == 'user' else segs,  # exclude live user
        live_query=live_query, budget=budget, llm=llm,
        experiment='taubench', item_id=f'{episode_id}_step{ep_step}',
        compactor_model='google/gemini-3-flash-preview',
    )
    # Re-render a chat-completion-ready message list. Always retain the live user.
    msgs_out = segments_to_chat_messages(res.segments)
    if live_query and (not msgs_out or msgs_out[-1].get('role') != 'user' or msgs_out[-1].get('content') != live_query):
        msgs_out.append({'role': 'user', 'content': live_query})
    return msgs_out, {
        'original_tokens': res.original_tokens,
        'compacted_tokens': res.compacted_tokens,
        'strategy': res.strategy,
    }


# -----------------------------------------------------------------------------
# Main runner: solve() variant that compacts before each LLM call
def _solve_one(env, task_idx, *, strategy, agent_model, agent_provider, wiki,
               tools_info, llm: LLMClient, budget=8000, max_steps=30,
               episode_id=''):
    total_cost = 0.0
    reward = 0.0
    env_reset_res = env.reset(task_index=task_idx)
    obs = env_reset_res.observation
    info = env_reset_res.info.model_dump()
    messages: List[Dict[str, Any]] = [
        {'role': 'system', 'content': wiki},
        {'role': 'user', 'content': obs},
    ]
    n_steps = 0
    n_tool_calls = 0
    compact_stats = []
    for step in range(max_steps):
        n_steps += 1
        # Compact if history grew large enough that compaction would matter.
        # Always compact (passes through if under budget).
        try:
            compacted_msgs, cstat = asyncio.get_event_loop().run_until_complete(
                compact_messages(messages, strategy=strategy, budget=budget, llm=llm,
                                  episode_id=episode_id, ep_step=step))
        except RuntimeError:
            # already a running loop; use new
            loop = asyncio.new_event_loop()
            try:
                compacted_msgs, cstat = loop.run_until_complete(
                    compact_messages(messages, strategy=strategy, budget=budget, llm=llm,
                                      episode_id=episode_id, ep_step=step))
            finally:
                loop.close()
        compact_stats.append(cstat)
        # Now do the agent step using the compacted message list, but the agent
        # still needs a properly formatted assistant_message reply with tool_calls.
        try:
            res = completion(
                messages=compacted_msgs,
                model=agent_model,
                custom_llm_provider=agent_provider,
                tools=tools_info,
                temperature=0.0,
            )
        except Exception as e:
            print(f'    LLM completion err at step {step}: {e}')
            break
        next_message = res.choices[0].message.model_dump()
        cost = (res._hidden_params or {}).get('response_cost') or 0.0
        total_cost += cost or 0.0

        action = message_to_action(next_message)
        env_response = env.step(action)
        reward = env_response.reward
        info = {**info, **env_response.info.model_dump()}
        if action.name != RESPOND_ACTION_NAME:
            n_tool_calls += 1
            tcs = next_message.get('tool_calls') or []
            tc = (tcs[0] if tcs else None) or {}
            tc_id = tc.get('id', f'call_{step}')
            messages.extend([
                {**next_message, 'tool_calls': [tc] if tc else []},
                {'role': 'tool', 'tool_call_id': tc_id,
                 'name': tc.get('function', {}).get('name', '?'),
                 'content': env_response.observation},
            ])
        else:
            messages.extend([
                next_message,
                {'role': 'user', 'content': env_response.observation},
            ])
        if env_response.done:
            break
    return {
        'reward': reward, 'n_steps': n_steps, 'n_tool_calls': n_tool_calls,
        'total_cost_litellm': total_cost,
        'compact_stats': compact_stats,
        'info': info,
    }


def main():
    import argparse
    p = argparse.ArgumentParser()
    p.add_argument('--n', type=int, default=25)
    p.add_argument('--max-steps', type=int, default=30)
    p.add_argument('--budget', type=int, default=8000)
    p.add_argument('--driver-model', default='openrouter/google/gemini-3-flash-preview')
    p.add_argument('--driver-provider', default='openrouter')
    p.add_argument('--user-model', default='openrouter/openai/gpt-4o-mini')
    p.add_argument('--user-provider', default='openrouter')
    p.add_argument('--strategies', default='rolling_summary,type_aware,task_aware')
    p.add_argument('--seed', type=int, default=42)
    p.add_argument('--spend-halt-usd', type=float, default=8.0)
    p.add_argument('--append', action='store_true')
    args = p.parse_args()

    load_prices(WORKDIR / 'openrouter_prices_snapshot.json')

    # Configure litellm to use OpenRouter
    os.environ['OPENROUTER_API_KEY'] = os.environ['OPENAI_API_KEY']
    # Note: passing custom_llm_provider="openrouter" routes to OpenRouter directly.
    # Our local proxy at 5090 also forwards to OpenRouter. Use openrouter for env+agent.

    env = get_env('retail',
                  user_strategy='llm', user_model=args.user_model,
                  user_provider=args.user_provider, task_split='test')
    print(f'env: {type(env).__name__}, {len(env.tasks)} tasks')

    rng = random.Random(args.seed)
    n_avail = len(env.tasks)
    idxs = sorted(rng.sample(range(n_avail), min(args.n, n_avail)))
    with open(WORKDIR / 'results/taubench_episode_ids.json', 'w') as f:
        json.dump(idxs, f)
    print(f'sampled {len(idxs)} episodes (seed={args.seed}): {idxs[:10]}...')

    strategies = [s.strip() for s in args.strategies.split(',') if s.strip()]

    out_path = WORKDIR / 'results/taubench_main.jsonl'
    if not args.append:
        out_path.unlink(missing_ok=True)
    out_f = open(out_path, 'a')

    llm = LLMClient(cache_dir=WORKDIR/'cache', cost_log_path=WORKDIR/'cost_log.jsonl',
                    max_concurrency=2)

    # Total spend tracker across episodes
    total_spent_litellm = 0.0
    started_at = time.time()

    for strat in strategies:
        for i, idx in enumerate(idxs):
            episode_id = f'retail_{idx}'
            try:
                t0 = time.time()
                r = _solve_one(env, idx, strategy=strat,
                               agent_model=args.driver_model,
                               agent_provider=args.driver_provider,
                               wiki=env.wiki, tools_info=env.tools_info,
                               llm=llm, budget=args.budget, max_steps=args.max_steps,
                               episode_id=f'{strat}_{episode_id}')
                dt = time.time() - t0
                row = {
                    'episode_id': episode_id, 'task_idx': idx, 'strategy': strat,
                    'reward': r['reward'], 'n_steps': r['n_steps'],
                    'n_tool_calls': r['n_tool_calls'],
                    'total_cost_litellm_usd': r['total_cost_litellm'],
                    'compact_stats_summary': {
                        'n_compactions': len(r['compact_stats']),
                        'mean_compacted_tokens': sum(c['compacted_tokens'] for c in r['compact_stats']) / max(1, len(r['compact_stats'])),
                        'max_original_tokens': max((c['original_tokens'] for c in r['compact_stats']), default=0),
                    },
                    'wallclock_s': dt,
                    'info_keys': list(r['info'].keys()),
                }
                total_spent_litellm += r['total_cost_litellm']
                out_f.write(json.dumps(row, default=str) + '\n')
                out_f.flush()
                print(f'  [{strat} {i+1}/{len(idxs)}] task={idx} reward={r["reward"]:.2f} '
                      f'steps={r["n_steps"]} tool_calls={r["n_tool_calls"]} '
                      f'litellm_usd=${r["total_cost_litellm"]:.4f} dt={dt:.1f}s')
            except Exception as e:
                print(f'  [{strat} {i+1}/{len(idxs)}] task={idx} FAIL: {e}')
                out_f.write(json.dumps({'episode_id': episode_id, 'task_idx': idx, 'strategy': strat, 'error': repr(e)}) + '\n')
                out_f.flush()

            # Halt check every 5 episodes
            if (i + 1) % 5 == 0:
                if total_spent_litellm > args.spend_halt_usd:
                    print(f'HALT: tau-bench litellm spend ${total_spent_litellm:.4f} > {args.spend_halt_usd}')
                    out_f.close(); return
    out_f.close()
    elapsed = time.time() - started_at
    print(f'\nFinished {len(strategies)} × {len(idxs)} = {len(strategies)*len(idxs)} runs in {elapsed:.0f}s; total litellm spend ~${total_spent_litellm:.4f}')


if __name__ == '__main__':
    main()
