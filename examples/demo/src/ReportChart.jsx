const width = 480
const height = 200

function scale(values) {
  const max = Math.max(...values)
  return values.map((value, index) => ({
    x: (index / (values.length - 1)) * width,
    y: height - (value / max) * height,
  }))
}

function linePath(points) {
  return points.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')
}

function exportCsv(values) {
  const blob = new Blob([values.join('\n')], {type: 'text/csv'})
  window.open(URL.createObjectURL(blob))
}

export function ReportChart({data}) {
  const points = scale(data)
  return (
    <figure>
      <svg width={width} height={height} role="img" aria-label="Weekly orders">
        <path d={linePath(points)} fill="none" stroke="currentColor" strokeWidth="2" />
        {points.map((p, i) => (
          <circle key={i} cx={p.x} cy={p.y} r="3" />
        ))}
      </svg>
      <button onClick={() => exportCsv(data)}>Export CSV</button>
    </figure>
  )
}
