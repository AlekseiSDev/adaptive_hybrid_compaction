"""Async OpenRouter client with cost logging + on-disk response cache.

All chat calls go through `complete()`. Each call is:
  1. Hashed (model, messages, kwargs) -> cache key.
  2. If cached, return cached response, log "cached" cost row (usd=0).
  3. Else issue HTTP call to local proxy (which forwards to OpenRouter).
  4. On success, persist response to cache, append cost row.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import aiohttp

PROXY_URL = os.environ.get("LLM_PROXY_URL", "http://127.0.0.1:5090/v1/chat/completions")

# Pricing snapshot loaded once.
_PRICES: dict[str, dict[str, float]] = {}


def load_prices(snapshot_path: str | Path) -> None:
    global _PRICES
    with open(snapshot_path) as f:
        snap = json.load(f)
    _PRICES = {}
    for mid, info in snap["models"].items():
        p = info.get("pricing") or {}
        # OpenRouter pricing is per-token (string in dollars).
        _PRICES[mid] = {
            "prompt": float(p.get("prompt", 0) or 0),
            "completion": float(p.get("completion", 0) or 0),
            "request": float(p.get("request", 0) or 0),
        }


def usd_for(model: str, prompt_tokens: int, completion_tokens: int) -> float:
    p = _PRICES.get(model)
    if not p:
        return 0.0
    return prompt_tokens * p["prompt"] + completion_tokens * p["completion"] + p["request"]


def _hash_payload(payload: dict) -> str:
    blob = json.dumps(payload, sort_keys=True, default=str).encode()
    return hashlib.sha256(blob).hexdigest()[:32]


@dataclass
class LLMCallResult:
    text: str
    prompt_tokens: int
    completion_tokens: int
    cached_tokens: int
    usd: float
    latency_s: float
    raw: dict
    cache_hit: bool


class LLMClient:
    def __init__(
        self,
        cache_dir: str | Path,
        cost_log_path: str | Path,
        proxy_url: str = PROXY_URL,
        max_concurrency: int = 8,
        timeout_s: float = 600.0,
    ):
        self.cache_dir = Path(cache_dir)
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.cost_log_path = Path(cost_log_path)
        self.cost_log_path.parent.mkdir(parents=True, exist_ok=True)
        self.proxy_url = proxy_url
        self._sem = asyncio.Semaphore(max_concurrency)
        self.timeout = aiohttp.ClientTimeout(total=timeout_s)

    def _cache_path(self, key: str) -> Path:
        return self.cache_dir / f"{key}.json"

    async def complete(
        self,
        model: str,
        messages: list[dict],
        *,
        temperature: float = 0.0,
        max_tokens: int | None = None,
        experiment: str = "",
        item_id: str = "",
        strategy: str = "",
        call_kind: str = "driver",  # driver|compactor|judge
        extra: dict[str, Any] | None = None,
    ) -> LLMCallResult:
        payload: dict[str, Any] = {
            "model": model,
            "messages": messages,
            "temperature": temperature,
        }
        if max_tokens is not None:
            payload["max_tokens"] = max_tokens
        if extra:
            payload.update(extra)

        key = _hash_payload({"model": model, "messages": messages,
                             "temperature": temperature, "max_tokens": max_tokens,
                             "extra": extra or {}})
        cpath = self._cache_path(key)

        if cpath.exists():
            with open(cpath) as f:
                cached = json.load(f)
            text = cached["text"]
            pt, ct = cached["prompt_tokens"], cached["completion_tokens"]
            usd = 0.0  # cache hit -> no cost
            self._log_cost(
                model=model, prompt_tokens=pt, completion_tokens=ct,
                cached_tokens=pt + ct, usd=0.0, experiment=experiment,
                item_id=item_id, strategy=strategy, call_kind=call_kind, cache_hit=True,
            )
            return LLMCallResult(
                text=text, prompt_tokens=pt, completion_tokens=ct,
                cached_tokens=pt + ct, usd=0.0,
                latency_s=cached.get("latency_s", 0.0), raw=cached.get("raw", {}),
                cache_hit=True,
            )

        async with self._sem:
            t0 = time.time()
            async with aiohttp.ClientSession(timeout=self.timeout) as sess:
                last_exc: Exception | None = None
                for attempt in range(4):
                    try:
                        async with sess.post(self.proxy_url, json=payload) as r:
                            if r.status >= 500 or r.status == 429:
                                txt = await r.text()
                                raise RuntimeError(f"proxy {r.status}: {txt[:300]}")
                            r.raise_for_status()
                            raw = await r.json()
                        break
                    except Exception as e:
                        last_exc = e
                        await asyncio.sleep(1.5 * (attempt + 1))
                else:
                    raise RuntimeError(f"LLM call failed after retries: {last_exc!r}")
            dt = time.time() - t0

        choice = raw["choices"][0]
        text = choice["message"].get("content") or ""
        usage = raw.get("usage", {}) or {}
        pt = int(usage.get("prompt_tokens", 0))
        ct = int(usage.get("completion_tokens", 0))
        cached_t = int(
            (usage.get("prompt_tokens_details") or {}).get("cached_tokens", 0)
            or usage.get("cached_tokens", 0)
            or 0
        )
        usd = usd_for(model, pt, ct)

        # Persist
        with open(cpath, "w") as f:
            json.dump({
                "text": text, "prompt_tokens": pt, "completion_tokens": ct,
                "cached_tokens": cached_t, "latency_s": dt, "raw": raw,
            }, f)

        self._log_cost(
            model=model, prompt_tokens=pt, completion_tokens=ct,
            cached_tokens=cached_t, usd=usd, experiment=experiment,
            item_id=item_id, strategy=strategy, call_kind=call_kind, cache_hit=False,
        )

        return LLMCallResult(
            text=text, prompt_tokens=pt, completion_tokens=ct,
            cached_tokens=cached_t, usd=usd, latency_s=dt, raw=raw, cache_hit=False,
        )

    def _log_cost(self, **row) -> None:
        from datetime import datetime, timezone
        row["ts"] = datetime.now(timezone.utc).isoformat()
        # rename for the user-visible schema
        out = {
            "ts": row["ts"],
            "route": row["model"],
            "input_tokens": row["prompt_tokens"],
            "output_tokens": row["completion_tokens"],
            "cached_tokens": row["cached_tokens"],
            "usd": row["usd"],
            "experiment": row["experiment"],
            "item_id": row["item_id"],
            "strategy": row["strategy"],
            "call_kind": row["call_kind"],
            "cache_hit": row["cache_hit"],
        }
        with open(self.cost_log_path, "a") as f:
            f.write(json.dumps(out) + "\n")
