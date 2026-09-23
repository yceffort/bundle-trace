'use client';
import {useEffect, useState} from 'react';
import {startup} from './startup.js';
import {drawChart, neverDrawn} from './chart.js';

export default function Page() {
  const [text, setText] = useState(startup);
  useEffect(() => { window.__btCorpusReady = true; }, []);
  return <main>
    <p id="result">{text}</p>
    <button id="report" onClick={() => setText(drawChart(1234))}>Open report</button>
    <button id="search" onClick={async () => setText((await import('./search.js')).search('ABC'))}>Search</button>
    <button id="never" onClick={() => setText(neverDrawn(1234))}>Unvisited action</button>
  </main>;
}
