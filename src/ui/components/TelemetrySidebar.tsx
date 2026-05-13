'use client';

import type { UIMessage } from 'ai';
import type { AhcStatsEnvelope } from '../lib/ahcStatsTypes';
import { FLAG_KEYS, type FeatureFlagKey } from '../lib/featureFlags';

export type AhcUIMessage = UIMessage<unknown, { ahc_stats: AhcStatsEnvelope }>;

function extractStats(messages: AhcUIMessage[]): AhcStatsEnvelope[] {
  const out: AhcStatsEnvelope[] = [];
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue;
    for (const part of msg.parts) {
      if (part.type === 'data-ahc_stats') out.push(part.data);
    }
  }
  return out;
}

function fmtNumber(n: number): string {
  return n.toLocaleString('en-US');
}

function fmtCost(cost: number): string {
  if (cost === 0) return '$0.0000';
  if (cost < 0.0001) return '<$0.0001';
  return `$${cost.toFixed(4)}`;
}

function fmtConfidence(c: number | null): string {
  if (c === null) return '—';
  return c.toFixed(2);
}

export function TelemetrySidebar({
  messages,
  activeFlags,
}: {
  messages: AhcUIMessage[];
  activeFlags: readonly FeatureFlagKey[];
}) {
  const stats = extractStats(messages);
  const latest = stats.at(-1) ?? null;
  const cumTokens = stats.reduce((s, e) => s + e.tokens.input + e.tokens.output, 0);
  const cumCost = stats.reduce((s, e) => s + e.cost_usd, 0);

  const activeSet = new Set<string>(activeFlags);

  return (
    <aside
      className="hidden h-full w-72 flex-col bg-gray-50 px-4 py-3 text-xs text-gray-600 md:flex"
      data-testid="telemetry-sidebar"
    >
      <h2 className="mb-2 text-sm font-semibold text-gray-700">AHC Telemetry</h2>

      {latest === null ? (
        <p className="text-gray-400" data-testid="telemetry-empty">
          No telemetry yet — send a message.
        </p>
      ) : (
        <div className="space-y-3">
          <section className="space-y-1">
            <Row label="class" value={latest.class ?? '—'} testId="telemetry-class" />
            <Row
              label="confidence"
              value={fmtConfidence(latest.confidence)}
              testId="telemetry-confidence"
            />
            <Row
              label="observations"
              value={fmtNumber(latest.observations_count)}
              testId="telemetry-observations"
            />
            <Row
              label="scratchpad"
              value={fmtNumber(latest.scratchpad_size)}
              testId="telemetry-scratchpad"
            />
            <Row
              label="recall events"
              value={fmtNumber(latest.recall_events_count)}
              testId="telemetry-recall"
            />
            <Row
              label="compactions"
              value={fmtNumber(latest.compaction_events_count)}
              testId="telemetry-compactions"
            />
          </section>

          <section className="border-t border-gray-200 pt-2">
            <div className="mb-1 text-[10px] uppercase tracking-wide text-gray-500">
              tokens (this turn)
            </div>
            <Row
              label="input"
              value={fmtNumber(latest.tokens.input)}
              testId="telemetry-tokens-input"
            />
            <Row
              label="output"
              value={fmtNumber(latest.tokens.output)}
              testId="telemetry-tokens-output"
            />
            <Row
              label="cache_read"
              value={fmtNumber(latest.tokens.cache_read)}
              testId="telemetry-tokens-cache-read"
            />
            <Row
              label="offloaded"
              value={fmtNumber(latest.tokens.offloaded)}
              testId="telemetry-tokens-offloaded"
            />
          </section>

          <section className="border-t border-gray-200 pt-2">
            <div className="mb-1 text-[10px] uppercase tracking-wide text-gray-500">
              cumulative
            </div>
            <Row label="total" value={fmtNumber(cumTokens)} testId="telemetry-cum-total" />
            <Row label="cost" value={fmtCost(cumCost)} testId="telemetry-cost-cumulative" />
          </section>
        </div>
      )}

      <section className="mt-3 border-t border-gray-200 pt-2">
        <div className="mb-1 text-[10px] uppercase tracking-wide text-gray-500">flags</div>
        <ul className="space-y-0.5">
          {FLAG_KEYS.map((key) => {
            const on = activeSet.has(key);
            return (
              <li
                key={key}
                data-testid={`telemetry-flag-${key}`}
                className={on ? 'text-gray-800' : 'text-gray-400'}
              >
                {on ? '[x]' : '[ ]'} {key}
              </li>
            );
          })}
        </ul>
      </section>
    </aside>
  );
}

function Row({ label, value, testId }: { label: string; value: string; testId: string }) {
  return (
    <div className="flex items-baseline justify-between">
      <span className="text-gray-500">{label}</span>
      <span className="font-mono text-gray-800" data-testid={testId}>
        {value}
      </span>
    </div>
  );
}
