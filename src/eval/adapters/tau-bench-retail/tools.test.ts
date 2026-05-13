import { describe, expect, it } from 'vitest'
import {
  cancelPendingOrder,
  findUserIdByEmail,
  findUserIdByNameZip,
  getOrderDetails,
  getProductDetails,
  getUserDetails,
  modifyPendingOrderAddress,
  modifyUserAddress,
  returnDeliveredOrderItems,
  retailTools,
  think,
} from './tools.js'
import type { EnvState, Order, User } from './types.js'

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
    products: {
      prod_a: {
        product_id: 'prod_a',
        name: 'Thing A',
        variants: {
          item_a1: { item_id: 'item_a1', options: {}, price: 25, available: true },
        },
      },
    },
  }
}

describe('retail tool pure functions — lookup', () => {
  it('findUserIdByEmail hit + miss', () => {
    const state = smokeState()
    expect(findUserIdByEmail(state, 'alice@example.com')).toBe('user_smoke_1')
    expect(findUserIdByEmail(state, 'nobody@example.com')).toBe('user_id_not_found')
  })

  it('findUserIdByNameZip hit + miss', () => {
    const state = smokeState()
    expect(findUserIdByNameZip(state, 'Alice', 'Smith', '90210')).toBe('user_smoke_1')
    expect(findUserIdByNameZip(state, 'Bob', 'Smith', '90210')).toBe('user_id_not_found')
  })

  it('getUserDetails / getOrderDetails / getProductDetails', () => {
    const state = smokeState()
    const u = getUserDetails(state, 'user_smoke_1')
    expect('error' in u ? false : u.email).toBe('alice@example.com')
    const o = getOrderDetails(state, 'order_1')
    expect('error' in o ? false : o.status).toBe('pending')
    const p = getProductDetails(state, 'prod_a')
    expect('error' in p ? false : p.name).toBe('Thing A')
  })

  it('get*Details — error on missing entity', () => {
    const state = smokeState()
    expect(getUserDetails(state, 'nobody')).toHaveProperty('error')
    expect(getOrderDetails(state, 'nope')).toHaveProperty('error')
    expect(getProductDetails(state, 'nope')).toHaveProperty('error')
  })
})

describe('cancelPendingOrder', () => {
  it('cancels pending + emits refund + mutates state', () => {
    const state = smokeState()
    const r = cancelPendingOrder(state, 'order_1')
    expect(r).toMatchObject({ ok: true, new_status: 'cancelled' })
    expect(state.orders['order_1']?.status).toBe('cancelled')
    const lastTx = state.orders['order_1']?.payment_history.at(-1)
    expect(lastTx?.transaction_type).toBe('refund')
    expect(lastTx?.amount).toBe(25)
  })

  it('refuses non-pending', () => {
    const state = smokeState()
    if (state.orders['order_1']) state.orders['order_1'].status = 'delivered'
    expect(cancelPendingOrder(state, 'order_1')).toHaveProperty('error')
  })

  it('error on missing order', () => {
    expect(cancelPendingOrder(smokeState(), 'nope')).toHaveProperty('error')
  })
})

describe('modifyPendingOrderAddress', () => {
  it('updates pending order address', () => {
    const state = smokeState()
    const r = modifyPendingOrderAddress(state, {
      order_id: 'order_1',
      address1: '99 New Rd',
      city: 'Newcity',
      country: 'US',
      zip: '11111',
    })
    expect(r).toMatchObject({ ok: true })
    expect(state.orders['order_1']?.address.address1).toBe('99 New Rd')
  })

  it('refuses non-pending', () => {
    const state = smokeState()
    if (state.orders['order_1']) state.orders['order_1'].status = 'delivered'
    expect(
      modifyPendingOrderAddress(state, {
        order_id: 'order_1',
        address1: 'x',
        city: 'y',
        country: 'US',
        zip: '1',
      }),
    ).toHaveProperty('error')
  })
})

describe('modifyUserAddress', () => {
  it('updates user address; tolerates missing optional fields', () => {
    const state = smokeState()
    modifyUserAddress(state, {
      user_id: 'user_smoke_1',
      address1: '42 New Ave',
      city: 'NewCity',
      country: 'US',
      zip: '99999',
    })
    expect(state.users['user_smoke_1']?.address.address1).toBe('42 New Ave')
    expect(state.users['user_smoke_1']?.address.state).toBeUndefined()
  })
})

describe('returnDeliveredOrderItems', () => {
  it('returns delivered + refund', () => {
    const state = smokeState()
    if (state.orders['order_1']) state.orders['order_1'].status = 'delivered'
    const r = returnDeliveredOrderItems(state, 'order_1', ['item_a1'], 'gift_1')
    expect(r).toMatchObject({ ok: true, refund: 25 })
    expect(state.orders['order_1']?.status).toBe('returned')
  })

  it('refuses non-delivered', () => {
    const state = smokeState()
    expect(returnDeliveredOrderItems(state, 'order_1', ['item_a1'], 'gift_1')).toHaveProperty('error')
  })

  it('refuses unknown item_id', () => {
    const state = smokeState()
    if (state.orders['order_1']) state.orders['order_1'].status = 'delivered'
    expect(returnDeliveredOrderItems(state, 'order_1', ['item_unknown'], 'gift_1')).toHaveProperty('error')
  })
})

describe('think', () => {
  it('records thought without side effects', () => {
    expect(think('Customer wants to cancel order')).toHaveProperty('noted')
  })

  it('truncates to 200 chars', () => {
    const r = think('x'.repeat(500))
    expect(r.noted.length).toBe(200)
  })
})

describe('retailTools wrapper integrity', () => {
  it('exposes 10 named tools matching AI SDK tool() shape', () => {
    const tools = retailTools(smokeState())
    const names = Object.keys(tools).sort()
    expect(names).toEqual(
      [
        'cancel_pending_order',
        'find_user_id_by_email',
        'find_user_id_by_name_zip',
        'get_order_details',
        'get_product_details',
        'get_user_details',
        'modify_pending_order_address',
        'modify_user_address',
        'return_delivered_order_items',
        'think',
      ].sort(),
    )
    for (const t of Object.values(tools)) {
      expect(t.description).toBeDefined()
      expect(t.inputSchema).toBeDefined()
    }
  })
})
