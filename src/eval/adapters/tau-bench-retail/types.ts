// Tau-bench retail env types. Per D5 plan Step 4.
//
// Simplified TS port of tau-bench retail (sierra-research/tau-bench
// envs/retail/data/*.json). Not byte-exact upstream — covers core fields used
// by tools in this dir. Per D5 Risk #2 acceptable divergence на 1-2 episodes
// из 25 documented в decisions.md.

export type Address = {
  address1: string
  address2?: string
  city: string
  country: string
  state?: string
  zip: string
}

export type PaymentMethod = {
  source: 'credit_card' | 'gift_card' | 'paypal'
  brand?: string
  last_four?: string
  id: string
  balance?: number
}

export type User = {
  user_id: string
  name: { first_name: string; last_name: string }
  email: string
  address: Address
  payment_methods: Record<string, PaymentMethod>
  orders: string[] // order_ids
}

export type ProductVariant = {
  item_id: string
  options: Record<string, string>
  price: number
  available: boolean
}

export type Product = {
  product_id: string
  name: string
  variants: Record<string, ProductVariant>
}

export type OrderItem = {
  product_id: string
  item_id: string
  name: string
  price: number
  options: Record<string, string>
}

export type OrderStatus =
  | 'pending'
  | 'processed'
  | 'delivered'
  | 'cancelled'
  | 'returned'
  | 'exchanged'

export type Order = {
  order_id: string
  user_id: string
  address: Address
  items: OrderItem[]
  fulfillments: { tracking_id: string[]; item_ids: string[] }[]
  status: OrderStatus
  payment_history: {
    transaction_type: 'payment' | 'refund'
    amount: number
    payment_method_id: string
  }[]
}

export type EnvState = {
  users: Record<string, User>
  orders: Record<string, Order>
  products: Record<string, Product>
}

// Partial-by-design: episode assertions name only the fields that must match
// (e.g. order.status='cancelled' without re-asserting the full Order shape).
export type ExpectedEndState = {
  users?: Record<string, Partial<User>>
  orders?: Record<string, Partial<Order>>
  products?: Record<string, Partial<Product>>
}

export type Episode = {
  episode_id: string
  task_idx: number
  instruction: string
  initial_state: EnvState
  expected_end_state: ExpectedEndState
}
