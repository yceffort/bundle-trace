import coldpathGraph from 'coldpath/vite'

export default {
  plugins: [coldpathGraph()],
  build: {sourcemap: true},
}
