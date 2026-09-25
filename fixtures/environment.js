function mobileLayout() {
  return 'mobile'
}
function desktopLayout() {
  return 'desktop'
}
function signedIn() {
  return 'account'
}
function signedOut() {
  return 'guest'
}
globalThis.__layout = matchMedia('(max-width: 600px)').matches ? mobileLayout() : desktopLayout()
globalThis.__session = document.cookie.includes('session=') ? signedIn() : signedOut()
