import {useState} from 'react'
import {formatNumber} from './format.js'
// Statically imported, but only rendered after a click.
import {ReportChart} from './ReportChart.jsx'

const totals = {visitors: 18204, orders: 1311, revenue: 90412}

export function Dashboard() {
  const [open, setOpen] = useState(false)
  const [results, setResults] = useState([])
  async function onSearch(event) {
    const {searchOrders} = await import('./search.js')
    setResults(searchOrders(event.target.value))
  }
  return (
    <main>
      <h1>Store dashboard</h1>
      <ul>
        {Object.entries(totals).map(([name, value]) => (
          <li key={name}>
            {name}: {formatNumber(value)}
          </li>
        ))}
      </ul>
      <button onClick={() => setOpen(true)}>Open report</button>
      {open && <ReportChart data={[12, 19, 7, 24, 16, 30, 22]} />}
      <input type="search" aria-label="Search orders" onChange={onSearch} />
      <ol data-testid="results">
        {results.map((order) => (
          <li key={order.id}>{order.customer}</li>
        ))}
      </ol>
    </main>
  )
}
