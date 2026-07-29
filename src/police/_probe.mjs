import { chromium } from 'playwright';
import { startServer } from '../../tools/lib/server.mjs';
const { port, server } = await startServer({});
const b = await chromium.launch({ headless: true, args:['--use-angle=metal','--ignore-gpu-blocklist','--mute-audio'] });
const p = await b.newPage({ viewport:{width:960,height:540} });
let nerr=0;
p.on('pageerror', e => { if(nerr++<5) console.log('PAGEERROR', String(e.message).slice(0,400)); });
p.on('console', m => { if (m.type()==='error' && nerr++<8) console.log('CONSOLE.ERR', m.text().slice(0,300)); });
await p.goto(`http://127.0.0.1:${port}/?q=high`, {waitUntil:'domcontentloaded'});
await p.waitForFunction('window.__READY__===true',null,{timeout:90000});
const pump=(n)=>p.evaluate(k=>new Promise(d=>{let i=0;const t=()=>++i>=k?d(true):requestAnimationFrame(t);requestAnimationFrame(t)}),n);
await pump(120);
console.log(await p.evaluate(l=>{const e=window.__ENGINE__;e.input.frozen=true;e.ctx.peek('player')?.setControlEnabled?.(false);return e.ctx.peek('police').debugChase({level:l,follow:true,maxDist:160});},3));
for (let i=0;i<18;i++){
  await pump(120);
  const s = await p.evaluate(()=>{const x=window.__ENGINE__.ctx.peek('police').sample();return JSON.parse(JSON.stringify(x));});
  const q=s.quarry; const nd = s.units.filter(u=>u.role!=='leave').map(u=>Math.hypot(u.x-q.x,u.z-q.z));
  console.log(i, 'lvl',s.level,'seen',s.seen,'units',s.units.length,'near',nd.length?Math.min(...nd).toFixed(1):'-','qv',q?q.speed.toFixed(1):'-','blocks',s.blocks.length,'U',s.units.map(u=>`${u.role[0]}${u.role[1]}:${u.d.toFixed(0)}m/${u.v.toFixed(0)}ms/${u.reason}/${u.stuck.toFixed(0)}`).join(' '),'RUN',JSON.stringify(s.runner));
}
await b.close(); server?.kill();
