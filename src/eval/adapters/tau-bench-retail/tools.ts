// Tau-bench retail tools as AI SDK v6 `tool()` definitions. Per D5 plan Step 4-5.
//
// 10 core retail tools (subset of upstream 16). Each tool closes over `envState`
// reference; mutations applied in-place reflect to outer scope (used by
// `agent-runner.ts` to read final state after `generateText` returns).
//
// Schemas via AI SDK `jsonSchema()` (NOT zod — AI SDK v6 + zod 4 has known
// type-inference incompatibility; `jsonSchema()` is the canonical alternative).

import { jsonSchema, tool, type ToolSet } from 'ai'
import type { Address, EnvState, Order, OrderItem, Product, User } from './types.js'

// --- pure tool impls ------------------------------------------------------

export type ToolResult<T> = T | { error: string }

export function findUserIdByEmail(state: EnvState, email: string): string {
  const user = Object.values(state.users).find((u) => u.email === email)
  return user ? user.user_id : 'user_id_not_found'
}

export function findUserIdByNameZip(
  state: EnvState,
  first_name: string,
  last_name: string,
  zip: string,
): string {
  const user = Object.values(state.users).find(
    (u) =>
      u.name.first_name === first_name &&
      u.name.last_name === last_name &&
      u.address.zip === zip,
  )
  return user ? user.user_id : 'user_id_not_found'
}

export function getUserDetails(state: EnvState, user_id: string): ToolResult<User> {
  const user = state.users[user_id]
  return user ?? { error: `user not found: ${user_id}` }
}

export function getOrderDetails(state: EnvState, order_id: string): ToolResult<Order> {
  const order = state.orders[order_id]
  return order ?? { error: `order not found: ${order_id}` }
}

export function getProductDetails(state: EnvState, product_id: string): ToolResult<Product> {
  const product = state.products[product_id]
  return product ?? { error: `product not found: ${product_id}` }
}

export function cancelPendingOrder(
  state: EnvState,
  order_id: string,
): ToolResult<{ ok: true; order_id: string; new_status: 'cancelled' }> {
  const order = state.orders[order_id]
  if (!order) return { error: `order not found: ${order_id}` }
  if (order.status !== 'pending') {
    return { error: `order ${order_id} not pending (status=${order.status})` }
  }
  order.status = 'cancelled'
  const refunds: typeof order.payment_history = []
  for (const p of order.payment_history) {
    if (p.transaction_type === 'payment') {
      refunds.push({
        transaction_type: 'refund',
        amount: p.amount,
        payment_method_id: p.payment_method_id,
      })
    }
  }
  order.payment_history.push(...refunds)
  return { ok: true, order_id, new_status: 'cancelled' }
}

function buildAddress(args: {
  address1: string
  address2?: string
  city: string
  country: string
  state?: string
  zip: string
}): Address {
  return {
    address1: args.address1,
    ...(args.address2 !== undefined ? { address2: args.address2 } : {}),
    city: args.city,
    country: args.country,
    ...(args.state !== undefined ? { state: args.state } : {}),
    zip: args.zip,
  }
}

export function modifyPendingOrderAddress(
  state: EnvState,
  args: { order_id: string; address1: string; address2?: string; city: string; country: string; state?: string; zip: string },
): ToolResult<{ ok: true; order_id: string; new_address: Address }> {
  const order = state.orders[args.order_id]
  if (!order) return { error: `order not found: ${args.order_id}` }
  if (order.status !== 'pending') {
    return { error: `order ${args.order_id} not pending (status=${order.status})` }
  }
  order.address = buildAddress(args)
  return { ok: true, order_id: args.order_id, new_address: order.address }
}

export function modifyUserAddress(
  state: EnvState,
  args: { user_id: string; address1: string; address2?: string; city: string; country: string; state?: string; zip: string },
): ToolResult<{ ok: true; user_id: string; new_address: Address }> {
  const user = state.users[args.user_id]
  if (!user) return { error: `user not found: ${args.user_id}` }
  user.address = buildAddress(args)
  return { ok: true, user_id: args.user_id, new_address: user.address }
}

export function returnDeliveredOrderItems(
  state: EnvState,
  order_id: string,
  item_ids: string[],
  payment_method_id: string,
): ToolResult<{ ok: true; order_id: string; refund: number }> {
  const order = state.orders[order_id]
  if (!order) return { error: `order not found: ${order_id}` }
  if (order.status !== 'delivered') {
    return { error: `order ${order_id} not delivered (status=${order.status})` }
  }
  const orderItemIds = new Set(order.items.map((it: OrderItem) => it.item_id))
  for (const id of item_ids) {
    if (!orderItemIds.has(id)) {
      return { error: `item_id ${id} not in order` }
    }
  }
  const refundAmount = order.items
    .filter((it: OrderItem) => item_ids.includes(it.item_id))
    .reduce((sum: number, it: OrderItem) => sum + it.price, 0)
  order.payment_history.push({
    transaction_type: 'refund',
    amount: refundAmount,
    payment_method_id,
  })
  order.status = 'returned'
  return { ok: true, order_id, refund: refundAmount }
}

export function think(thought: string): { noted: string } {
  return { noted: thought.slice(0, 200) }
}

// --- AI SDK v6 tool wrappers (jsonSchema, no zod) -------------------------

const addressJsonProps = {
  address1: { type: 'string' as const },
  address2: { type: 'string' as const },
  city: { type: 'string' as const },
  country: { type: 'string' as const },
  state: { type: 'string' as const },
  zip: { type: 'string' as const },
}
const addressRequired = ['address1', 'city', 'country', 'zip'] as const

export function retailTools(envState: EnvState): ToolSet {
  return {
    find_user_id_by_email: tool({
      description: 'Find a user_id by their email address. Returns "user_id_not_found" if no match.',
      inputSchema: jsonSchema<{ email: string }>({
        type: 'object',
        properties: { email: { type: 'string' } },
        required: ['email'],
      }),
      execute: ({ email }) => findUserIdByEmail(envState, email),
    }),

    find_user_id_by_name_zip: tool({
      description: 'Find a user_id by first_name + last_name + zip. Returns "user_id_not_found" if no match.',
      inputSchema: jsonSchema<{ first_name: string; last_name: string; zip: string }>({
        type: 'object',
        properties: {
          first_name: { type: 'string' },
          last_name: { type: 'string' },
          zip: { type: 'string' },
        },
        required: ['first_name', 'last_name', 'zip'],
      }),
      execute: ({ first_name, last_name, zip }) =>
        findUserIdByNameZip(envState, first_name, last_name, zip),
    }),

    get_user_details: tool({
      description: 'Get full record for a user by user_id.',
      inputSchema: jsonSchema<{ user_id: string }>({
        type: 'object',
        properties: { user_id: { type: 'string' } },
        required: ['user_id'],
      }),
      execute: ({ user_id }) => getUserDetails(envState, user_id),
    }),

    get_order_details: tool({
      description: 'Get full record for an order by order_id.',
      inputSchema: jsonSchema<{ order_id: string }>({
        type: 'object',
        properties: { order_id: { type: 'string' } },
        required: ['order_id'],
      }),
      execute: ({ order_id }) => getOrderDetails(envState, order_id),
    }),

    get_product_details: tool({
      description: 'Get product info by product_id (name + available variants).',
      inputSchema: jsonSchema<{ product_id: string }>({
        type: 'object',
        properties: { product_id: { type: 'string' } },
        required: ['product_id'],
      }),
      execute: ({ product_id }) => getProductDetails(envState, product_id),
    }),

    cancel_pending_order: tool({
      description: 'Cancel a pending order. Refunds all payments. Reason: "no longer needed" or "ordered by mistake".',
      inputSchema: jsonSchema<{ order_id: string; reason: string }>({
        type: 'object',
        properties: {
          order_id: { type: 'string' },
          reason: { type: 'string', enum: ['no longer needed', 'ordered by mistake'] },
        },
        required: ['order_id', 'reason'],
      }),
      execute: ({ order_id }) => cancelPendingOrder(envState, order_id),
    }),

    modify_pending_order_address: tool({
      description: 'Change shipping address of a pending order.',
      inputSchema: jsonSchema<{
        order_id: string
        address1: string
        address2?: string
        city: string
        country: string
        state?: string
        zip: string
      }>({
        type: 'object',
        properties: { order_id: { type: 'string' }, ...addressJsonProps },
        required: ['order_id', ...addressRequired],
      }),
      execute: (args) => modifyPendingOrderAddress(envState, args),
    }),

    modify_user_address: tool({
      description: "Change a user's default address. Does not affect existing order addresses.",
      inputSchema: jsonSchema<{
        user_id: string
        address1: string
        address2?: string
        city: string
        country: string
        state?: string
        zip: string
      }>({
        type: 'object',
        properties: { user_id: { type: 'string' }, ...addressJsonProps },
        required: ['user_id', ...addressRequired],
      }),
      execute: (args) => modifyUserAddress(envState, args),
    }),

    return_delivered_order_items: tool({
      description: 'Return items from a delivered order. item_ids must be subset of order.items.',
      inputSchema: jsonSchema<{
        order_id: string
        item_ids: string[]
        payment_method_id: string
      }>({
        type: 'object',
        properties: {
          order_id: { type: 'string' },
          item_ids: { type: 'array', items: { type: 'string' } },
          payment_method_id: { type: 'string' },
        },
        required: ['order_id', 'item_ids', 'payment_method_id'],
      }),
      execute: ({ order_id, item_ids, payment_method_id }) =>
        returnDeliveredOrderItems(envState, order_id, item_ids, payment_method_id),
    }),

    think: tool({
      description: 'Internal note / planning tool. No side effects.',
      inputSchema: jsonSchema<{ thought: string }>({
        type: 'object',
        properties: { thought: { type: 'string' } },
        required: ['thought'],
      }),
      execute: ({ thought }) => think(thought),
    }),
  }
}
