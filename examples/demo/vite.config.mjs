import coldpathGraph from '@yceffort/coldpath/vite'

export default {
  plugins: [coldpathGraph()],
  build: {sourcemap: true},
}
