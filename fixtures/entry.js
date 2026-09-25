import {makeFeature, unusedFeature} from './feature.js'
import './startup.js'

globalThis.__coldpathApp = {run: makeFeature(), unusedFeature}
