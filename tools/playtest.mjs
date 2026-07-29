import { chromium } from 'playwright';
import { startServer } from './lib/server.mjs';

/**
 * Scripted movement/fire smoke test.
 *
 * Brings up its OWN HMR-disabled vite (see tools/lib/server.mjs). It used to
 * point at a hardcoded :8080 that nobody was serving, and before that at
 * whatever squatted :5173 — which, with a fleet of agents saving files, meant
 * the page reloaded mid-test every few seconds and the run timed out. Two agents
 * lost time to that; one worked around it by serving `dist/` by hand.
 */
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? true] : [a, true]; })
);
const { port: PORT, server } = await startServer({ explicitPort: args.port });

const b = await chromium.launch({ headless: true, args:['--use-angle=metal','--ignore-gpu-blocklist','--mute-audio','--disable-frame-rate-limit'] });
const p = await b.newPage({ viewport:{width:1280,height:720} });
const errs=[]; p.on('pageerror',e=>errs.push(e.message)); p.on('console',m=>m.type()==='error'&&errs.push(m.text()));
await p.goto(`http://127.0.0.1:${PORT}/`, {waitUntil:'domcontentloaded'});
await p.waitForFunction('window.__READY__===true',null,{timeout:60000});
const snap = () => p.evaluate(()=>{const e=window.__ENGINE__,c=e.camera.position;return{
  pos:[+c.x.toFixed(2),+c.y.toFixed(2),+c.z.toFixed(2)],
  yaw:+e.camera.rotation.y.toFixed(3), frame:e.time.frame,
  systems:Object.keys(e.ctx).length}});
const a = await snap();
// hold W for ~40 frames
await p.evaluate(()=>{const e=window.__ENGINE__; e.input.enabled=true; e.input.frozen=false;
  e.ctx.peek('player')?.setControlEnabled?.(true);});
await p.keyboard.down('w');
await p.evaluate(()=>new Promise(d=>{let i=0;const t=()=>++i>=45?d():requestAnimationFrame(t);requestAnimationFrame(t)}));
await p.keyboard.up('w');
const bpos = await snap();
// fire a shot via the input layer
const fired = await p.evaluate(()=>{let n=0; const off=window.__ENGINE__.events.on('weapon:fire',()=>n++);
  const w=window.__ENGINE__.ctx.peek('weapons'); try{ w?.debugPose?.('fire',{grabFrame:1}); }catch(e){}
  return new Promise(d=>{let i=0;const t=()=>++i>=30?(off(),d(n)):requestAnimationFrame(t);requestAnimationFrame(t)})});
// count scene objects + check for NaN transforms
const health = await p.evaluate(()=>{const e=window.__ENGINE__; let n=0,nan=0;
  e.scene.traverse(o=>{n++; const v=o.position; if(!Number.isFinite(v.x+v.y+v.z)) nan++;});
  let vm=0; e.viewScene.traverse(()=>vm++);
  return {worldObjects:n, viewmodelObjects:vm, nanTransforms:nan, fps:+(1000/(e.time.dt*1000||16.6)).toFixed(0)}});
const moved = Math.hypot(bpos.pos[0]-a.pos[0], bpos.pos[2]-a.pos[2]);
console.log(JSON.stringify({ready:true, startPos:a.pos, afterW:bpos.pos, metresMoved:+moved.toFixed(2),
  framesAdvanced:bpos.frame-a.frame, fireEvents:fired, ...health, errors:errs.slice(0,8)},null,2));
await b.close();
server?.kill();
