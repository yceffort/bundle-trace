function firstPage() {
  return 'first'
}
function beforeLeaving() {
  globalThis.__left = true
}
globalThis.__first = firstPage()
document.addEventListener('click', beforeLeaving)
