import type { FeatureFlags } from '../../core/featureFlags';

export const FLAG_KEYS = [
  'TASK_AWARE_EXTRACTION',
  'TYPE_AWARE_OFFLOAD',
  'TRAJECTORY_CLASSIFIER',
  'ASYNC_OBSERVER',
  'RECALL_TOOL',
  'SCHEMA_AWARE_DIGEST',
  'REFLECTION',
  'CALIBRATION_AUTO',
] as const satisfies readonly (keyof FeatureFlags)[];

export type FeatureFlagKey = (typeof FLAG_KEYS)[number];

export const DEMO_DEFAULTS: FeatureFlags = {
  TASK_AWARE_EXTRACTION: true,
  TYPE_AWARE_OFFLOAD: true,
  TRAJECTORY_CLASSIFIER: true,
  ASYNC_OBSERVER: true,
  RECALL_TOOL: true,
  SCHEMA_AWARE_DIGEST: true,
  REFLECTION: true,
  CALIBRATION_AUTO: false,
};

export function parseFlagsFromUrl(url: URL): FeatureFlags {
  const merged: FeatureFlags = { ...DEMO_DEFAULTS };
  for (const key of FLAG_KEYS) {
    const raw = url.searchParams.get(key);
    if (raw === null) continue;
    if (raw === '0' || raw === 'false') merged[key] = false;
    else if (raw === '1' || raw === 'true') merged[key] = true;
  }
  return merged;
}

export function activeFlagNames(flags: FeatureFlags): readonly FeatureFlagKey[] {
  return FLAG_KEYS.filter((k) => flags[k]);
}
