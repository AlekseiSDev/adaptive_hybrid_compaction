// Tau-bench retail env loader + clone + reward calc. Per D5 plan Step 4.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { EnvState, ExpectedEndState, Order, Product, User } from './types.js'

function dataDir(): string {
  return join(process.cwd(), 'benchmarks/tau-bench/data')
}

export async function loadInitialState(dir: string = dataDir()): Promise<EnvState> {
  const [usersRaw, ordersRaw, productsRaw] = await Promise.all([
    readFile(join(dir, 'users.json'), 'utf8'),
    readFile(join(dir, 'orders.json'), 'utf8'),
    readFile(join(dir, 'products.json'), 'utf8'),
  ])
  const usersArr = JSON.parse(usersRaw) as User[] | Record<string, User>
  const ordersArr = JSON.parse(ordersRaw) as Order[] | Record<string, Order>
  const productsArr = JSON.parse(productsRaw) as Product[] | Record<string, Product>

  const users: Record<string, User> = Array.isArray(usersArr)
    ? Object.fromEntries(usersArr.map((u) => [u.user_id, u]))
    : usersArr
  const orders: Record<string, Order> = Array.isArray(ordersArr)
    ? Object.fromEntries(ordersArr.map((o) => [o.order_id, o]))
    : ordersArr
  const products: Record<string, Product> = Array.isArray(productsArr)
    ? Object.fromEntries(productsArr.map((p) => [p.product_id, p]))
    : productsArr

  return { users, orders, products }
}

export function cloneEnvState(state: EnvState): EnvState {
  return JSON.parse(JSON.stringify(state)) as EnvState
}

// Reward calc: simplified version of tau-bench retail
// `envs/retail/env.py:calculate_reward`. Returns 1.0 if all asserted
// fields in `expected_end_state` match actual `envState`; 0.0 otherwise.
// Order matters less than presence + content equivalence.
//
// Per D5 Risk #2: not byte-exact upstream — flags structural mismatch
// (e.g. expected order status='cancelled' vs actual 'pending') as failure.
export function calculateReward(
  envState: EnvState,
  expected: ExpectedEndState,
): number {
  if (expected.orders) {
    for (const [orderId, expectedOrder] of Object.entries(expected.orders)) {
      const actual = envState.orders[orderId]
      if (!actual) return 0
      // Status must match
      if (expectedOrder.status !== undefined && actual.status !== expectedOrder.status) {
        return 0
      }
      // Items: if expected.items present, compare item_ids set equality
      if (expectedOrder.items !== undefined) {
        const expIds = new Set(expectedOrder.items.map((it) => it.item_id))
        const actIds = new Set(actual.items.map((it) => it.item_id))
        if (expIds.size !== actIds.size) return 0
        for (const id of expIds) {
          if (!actIds.has(id)) return 0
        }
      }
    }
  }
  if (expected.users) {
    for (const [userId, expectedUser] of Object.entries(expected.users)) {
      const actual = envState.users[userId]
      if (!actual) return 0
      // Address fields if expected
      if (expectedUser.address !== undefined) {
        const ea = expectedUser.address
        const aa = actual.address
        if (
          ea.address1 !== aa.address1 ||
          ea.city !== aa.city ||
          ea.zip !== aa.zip
        ) {
          return 0
        }
      }
    }
  }
  return 1
}
