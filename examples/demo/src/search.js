const orders = [
  {id: 1, customer: 'Ada Lovelace'},
  {id: 2, customer: 'Grace Hopper'},
  {id: 3, customer: 'Alan Turing'},
  {id: 4, customer: 'Katherine Johnson'},
]

export function searchOrders(query) {
  const needle = query.trim().toLowerCase()
  return needle ? orders.filter((order) => order.customer.toLowerCase().includes(needle)) : []
}
