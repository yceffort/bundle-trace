function secondPage() {
  return 'second'
}
globalThis.__second = secondPage()
const worker = new Worker('/assets/worker.js')
worker.onmessage = (event) => {
  globalThis.__worker = event.data
}
