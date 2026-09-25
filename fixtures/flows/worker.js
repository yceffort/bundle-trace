function workerRun() {
  return 42
}
function workerNever() {
  return 0
}
postMessage(workerRun())
