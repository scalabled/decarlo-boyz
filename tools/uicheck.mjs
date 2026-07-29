import { chromium } from 'playwright';
import { startServer } from './lib/server.mjs';
const { port, server } = await startServer({});
const b = await chromium.launch({ args:['--use-angle=metal','--mute-audio'] });
const p = await b.newPage({viewport:{width:1280,height:720}});
await p.goto(`http://127.0.0.1:${port}/?capture=1&shot=night`, {waitUntil:'domcontentloaded'});
await p.waitForFunction('window.__READY__===true',null,{timeout:90000});
await p.evaluate(()=>window.__APPLY_SHOT__('night',{grabFrame:60}));
await p.evaluate(()=>new Promise(d=>{let i=0;const t=()=>++i>=90?d():requestAnimationFrame(t);requestAnimationFrame(t)}));
console.log(JSON.stringify(await p.evaluate(()=>{
  const e=window.__ENGINE__, sky=e.ctx.peek('sky'), ui=e.ctx.peek('ui');
  return { skyHour: sky?.hour, skyTOD: sky?.timeOfDay, uiStateHour: ui?.state?.hour,
           clockText: document.querySelector('.ow-clock')?.textContent };
}),null,2));
await b.close(); server?.kill();
