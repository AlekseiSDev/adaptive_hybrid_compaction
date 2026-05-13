import { describe, expect, test } from 'vitest'
import { parseArgs, validateSweep, VALID_PROVIDERS } from './eval.js'

// validateSweep — sweep YAML schema sanity. Tests the optional E0 `provider`
// per-row enum check + the pre-existing required-keys check, so future
// schema additions land with TDD coverage.

const baseSweep = {
  name: 'test_sweep',
  benches: ['synthetic'],
  configs: [{ id: 'c0', baseline: 'noop_baseline' }],
  seeds: [42],
  budget_usd: 1,
}

describe('validateSweep — required keys', () => {
  test('accepts a minimal valid sweep', () => {
    expect(() => validateSweep(baseSweep, 'test.yaml')).not.toThrow()
  })

  test('rejects when required key is missing', () => {
    const noBudget = { ...baseSweep } as Record<string, unknown>
    delete noBudget['budget_usd']
    expect(() => validateSweep(noBudget, 'test.yaml')).toThrow(/budget_usd/)
  })

  test('rejects non-object input', () => {
    expect(() => validateSweep('not an object', 'test.yaml')).toThrow(/YAML object/)
    expect(() => validateSweep([1, 2, 3], 'test.yaml')).toThrow(/YAML object/)
  })
})

describe('validateSweep — provider per-row enum (E0)', () => {
  test('accepts row with provider:"anthropic_direct"', () => {
    const sweep = {
      ...baseSweep,
      configs: [{ id: 'c0', ahc_flags: {}, provider: 'anthropic_direct' }],
    }
    expect(() => validateSweep(sweep, 'test.yaml')).not.toThrow()
  })

  test('accepts row with provider:"openrouter"', () => {
    const sweep = {
      ...baseSweep,
      configs: [{ id: 'c0', ahc_flags: {}, provider: 'openrouter' }],
    }
    expect(() => validateSweep(sweep, 'test.yaml')).not.toThrow()
  })

  test('accepts row without provider field (optional)', () => {
    const sweep = {
      ...baseSweep,
      configs: [{ id: 'c0', baseline: 'noop_baseline' }],
    }
    expect(() => validateSweep(sweep, 'test.yaml')).not.toThrow()
  })

  test('rejects invalid provider value', () => {
    const sweep = {
      ...baseSweep,
      configs: [{ id: 'c0', ahc_flags: {}, provider: 'fake_provider' }],
    }
    expect(() => validateSweep(sweep, 'test.yaml')).toThrow(/invalid provider "fake_provider"/)
  })

  test('lists valid providers in error message', () => {
    const sweep = {
      ...baseSweep,
      configs: [{ id: 'c0', ahc_flags: {}, provider: 'azure' }],
    }
    expect(() => validateSweep(sweep, 'test.yaml')).toThrow(/openrouter|anthropic_direct/)
  })
})

describe('VALID_PROVIDERS constant', () => {
  test('contains both providers', () => {
    expect(VALID_PROVIDERS.has('openrouter')).toBe(true)
    expect(VALID_PROVIDERS.has('anthropic_direct')).toBe(true)
    expect(VALID_PROVIDERS.size).toBe(2)
  })
})

describe('parseArgs — --dry-run + --n-per-cell (E0)', () => {
  test('--sweep only: dryRun=false, nPerCell default', () => {
    const args = parseArgs(['--sweep', 'plan.yaml'])
    expect(args.sweep).toBe('plan.yaml')
    expect(args.dryRun).toBe(false)
    expect(args.nPerCell).toBe(2)
  })

  test('--dry-run flag: dryRun=true, default n-per-cell still 2', () => {
    const args = parseArgs(['--sweep', 'plan.yaml', '--dry-run'])
    expect(args.dryRun).toBe(true)
    expect(args.nPerCell).toBe(2)
  })

  test('--n-per-cell=N parses positive integer', () => {
    const args = parseArgs(['--sweep', 'plan.yaml', '--dry-run', '--n-per-cell=5'])
    expect(args.nPerCell).toBe(5)
  })

  test('throws on missing --sweep', () => {
    expect(() => parseArgs([])).toThrow(/usage:/)
    expect(() => parseArgs(['--dry-run'])).toThrow(/usage:/)
  })

  test('throws on --n-per-cell with non-integer', () => {
    expect(() => parseArgs(['--sweep', 'p.yaml', '--n-per-cell=abc'])).toThrow(/positive integer/)
  })

  test('throws on --n-per-cell with zero or negative', () => {
    expect(() => parseArgs(['--sweep', 'p.yaml', '--n-per-cell=0'])).toThrow(/positive integer/)
    expect(() => parseArgs(['--sweep', 'p.yaml', '--n-per-cell=-3'])).toThrow(/positive integer/)
  })
})
