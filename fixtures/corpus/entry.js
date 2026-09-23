import {startup} from './startup.js';
import {drawChart, neverDrawn} from './chart.js';

globalThis.corpus = {
  initial: startup(),
  openReport: () => drawChart(1234),
  search: async () => (await import('./search.js')).search('ABC'),
  neverDrawn,
};
