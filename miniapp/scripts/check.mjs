import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Script} from 'node:vm';
import worker,{identity,schedule} from '../worker/index.js';
const page=await readFile('page.html','utf8');
for(const match of page.matchAll(/<script>([\s\S]*?)<\/script>/g))new Script(match[1]);
const env={TELEGRAM_BOT_TOKEN:'test-token',TEACHER_IDS:'1'};
async function signed(user,age=0){const q=new URLSearchParams({auth_date:String(Math.floor(Date.now()/1000)-age),user:JSON.stringify({id:user,first_name:'Test'})});
 const enc=new TextEncoder();async function mac(key,data){const k=await crypto.subtle.importKey('raw',typeof key==='string'?enc.encode(key):key,{name:'HMAC',hash:'SHA-256'},false,['sign']);return crypto.subtle.sign('HMAC',k,enc.encode(data))}
 const check=[...q.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>k+'='+v).join('\n');
 q.set('hash',Buffer.from(await mac(await mac('WebAppData','test-token'),check)).toString('hex'));return new Request('https://test/api/state',{headers:{'x-telegram-init-data':q.toString()}})}
assert.equal((await identity(await signed(1),env)).role,'teacher');
assert.equal((await identity(await signed(2),env)).role,'student');
await assert.rejects(identity(await signed(1,90000),env));
await assert.rejects(identity(new Request('https://test/api/state'),env));
assert.equal(schedule('26-DCPS-01','2026-10-14').week,7);
assert.ok(schedule('26-DCPS-01','2026-10-14').lessons.every(l=>l.weeks.includes(7)&&l.day===2));
assert.equal(schedule('26-DCPS-01','2026-10-18').lessons.length,0);
assert.equal(schedule('26-DCPS-01','2027-02-01').lessons.length,0);
const demo=await worker.fetch(new Request('https://test/api/demo'),{});assert.equal(demo.status,200);assert.equal((await demo.json()).groups.length,59);
const denied=await worker.fetch(new Request('https://test/api/tasks',{method:'POST',body:'{}'}),env);assert.equal(denied.status,401);
const deniedService=await worker.fetch(new Request('https://test/api/bot/task',{method:'POST',body:'{}'}),env);assert.equal(deniedService.status,401);
console.log('Frontend syntax, semester filtering, Telegram signatures, expiration and service authorization passed.');
