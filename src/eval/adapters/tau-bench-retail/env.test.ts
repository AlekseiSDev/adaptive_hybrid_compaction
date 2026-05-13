import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { calculateReward, cloneEnvState, loadInitialState } from './env.js'
import type { EnvState, ExpectedEndState, Order, User } from './types.js'

function smokeUser(): User {
  return {
    user_id: 'user_smoke_1',
    name: { first_name: 'Alice', last_name: 'Smith' },
    email: 'alice@example.com',
    address: {
      address1: '1 Main St',
      city: 'Springfield',
      country: 'US',
      state: 'CA',
      zip: '90210',
    },
    payment_methods: {
      gift_1: { source: 'gift_card', id: 'gift_1', balance: 100 },
    },
    orders: ['order_1'],
  }
}

function smokeOrder(): Order {
  return {
    order_id: 'order_1',
    user_id: 'user_smoke_1',
    address: {
      address1: '1 Main St',
      city: 'Springfield',
      country: 'US',
      zip: '90210',
    },
    items: [
      {
        product_id: 'prod_a',
        item_id: 'item_a1',
        name: 'Thing A',
        price: 25,
        options: {},
      },
    ],
    fulfillments: [],
    status: 'pending',
    payment_history: [
      { transaction_type: 'payment', amount: 25, payment_method_id: 'gift_1' },
    ],
  }
}

function smokeState(): EnvState {
  return {
    users: { user_smoke_1: smokeUser() },
    orders: { order_1: smokeOrder() },
    products: {},
  }
}

describe('loadInitialState', () => {
  it('reads users/orders/products JSON into EnvState (array form)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ahc-tau-env-'))
    try {
      writeFileSync(join(dir, 'users.json'), JSON.stringify([smokeUser()]))
      writeFileSync(join(dir, 'orders.json'), JSON.stringify([smokeOrder()]))
      writeFileSync(join(dir, 'products.json'), JSON.stringify([]))
      const state = await loadInitialState(dir)
      expect(state.users['user_smoke_1']?.email).toBe('alice@example.com')
      expect(state.orders['order_1']?.status).toBe('pending')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reads users/orders/products from object-form JSON', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ahc-tau-env-'))
    try {
      const u = smokeUser()
      const o = smokeOrder()
      writeFileSync(join(dir, 'users.json'), JSON.stringify({ [u.user_id]: u }))
      writeFileSync(join(dir, 'orders.json'), JSON.stringify({ [o.order_id]: o }))
      writeFileSync(join(dir, 'products.json'), JSON.stringify({}))
      const state = await loadInitialState(dir)
      expect(state.users['user_smoke_1']?.email).toBe('alice@example.com')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('cloneEnvState', () => {
  it('deep clones — mutations to clone do not affect source', () => {
    const src = smokeState()
    const clone = cloneEnvState(src)
    if (clone.orders['order_1']) clone.orders['order_1'].status = 'cancelled'
    expect(src.orders['order_1']?.status).toBe('pending')
  })
})

describe('calculateReward', () => {
  it('returns 1 when expected order status matches actual', () => {
    const state = smokeState()
    if (state.orders['order_1']) state.orders['order_1'].status = 'cancelled'
    const r = calculateReward(state, { orders: { order_1: { status: 'cancelled' } } })
    expect(r).toBe(1)
  })

  it('returns 0 when expected order status differs', () => {
    const state = smokeState()
    const r = calculateReward(state, { orders: { order_1: { status: 'cancelled' } } })
    expect(r).toBe(0)
  })

  it('returns 0 when expected order missing in env', () => {
    const state = smokeState()
    const r = calculateReward(state, { orders: { order_missing: { status: 'delivered' } } })
    expect(r).toBe(0)
  })

  it('compares item_ids set equality when expected.items provided', () => {
    const state = smokeState()
    const expected: ExpectedEndState = {
      orders: {
        order_1: {
          status: 'pending',
          items: [
            { product_id: 'prod_a', item_id: 'item_a1', name: '', price: 0, options: {} },
          ],
        },
      },
    }
    expect(calculateReward(state, expected)).toBe(1)

    const wrongItems: ExpectedEndState = {
      orders: {
        order_1: {
          status: 'pending',
          items: [
            { product_id: 'prod_b', item_id: 'item_b1', name: '', price: 0, options: {} },
          ],
        },
      },
    }
    expect(calculateReward(state, wrongItems)).toBe(0)
  })

  it('checks user address when expected.users provided', () => {
    const state = smokeState()
    const matching: ExpectedEndState = {
      users: {
        user_smoke_1: {
          address: { address1: '1 Main St', city: 'Springfield', country: 'US', zip: '90210' },
        },
      },
    }
    expect(calculateReward(state, matching)).toBe(1)

    const wrongAddress: ExpectedEndState = {
      users: {
        user_smoke_1: {
          address: { address1: '99 Other Ave', city: 'Otherville', country: 'US', zip: '12345' },
        },
      },
    }
    expect(calculateReward(state, wrongAddress)).toBe(0)
  })

  it('returns 1 when expected is empty (no assertions)', () => {
    expect(calculateReward(smokeState(), {})).toBe(1)
  })
})

// Smoke directory creation (for adapter loadTasks tests downstream)
describe('smoke setup', () => {
  it('mkdir benchmarks/tau-bench/{tasks,data} works', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ahc-tau-smoke-'))
    try {
      mkdirSync(join(dir, 'benchmarks/tau-bench/tasks'), { recursive: true })
      mkdirSync(join(dir, 'benchmarks/tau-bench/data'), { recursive: true })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
