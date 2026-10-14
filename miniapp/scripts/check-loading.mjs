import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import worker from '../worker/index.js';
const page=await readFile('page.html','utf8');
const script=page.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/\nboot\(\);\s*$/,'');
const values=new Map();let calls=0,answer;
const sandbox={window:{},localStorage:{getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)},
 document:{getElementById:()=>null,addEventListener:()=>{}},Intl,Date,JSON,Map,Set,Promise,AbortController,Error,setTimeout,clearTimeout,
 fetch:async()=>{calls++;return await new Promise(r=>answer=r)},console,renderCount:0};
const context=vm.createContext(sandbox);vm.runInContext(script,context);
vm.runInContext(`catalog={version:'test',semesterStart:'2026-08-31',semesterEnd:'2027-01-01',groups:[{id:'A'},{id:'B'}]};group='A';groupEpoch=1;allLessons=[{day:2,weeks:[7],subject:'Math'}];data={user:{id:'42',role:'student'},demo:false,group:'A',profile:{group:'A'},tasks:[{id:'existing'}],submissions:[]};render=()=>{renderCount++};showSync=()=>{};`,context);
for(let i=0;i<100;i++)vm.runInContext(`showDate('${i%2?'2026-10-15':'2026-10-14'}')`,context);
assert.equal(calls,0,'Date changes must never send network requests');assert.equal(sandbox.renderCount,100);
const flight=vm.runInContext('refreshRemote(true)',context);
for(let i=0;i<10;i++)vm.runInContext('refreshRemote(true)',context);
assert.equal(calls,1,'Repeated refreshes must share one request');
vm.runInContext("group='B';groupEpoch++;data.group='B';data.tasks=[{id:'newer-group'}]",context);
answer({ok:true,json:async()=>({profile:{group:'A'},tasks:[{id:'old-response'}],submissions:[]})});await flight;
assert.equal(vm.runInContext('data.group',context),'B');assert.equal(vm.runInContext('data.tasks[0].id',context),'newer-group');
values.set('dc-schedule:test:B',JSON.stringify({version:'test',group:'B',lessons:[{subject:'Cached'}]}));
assert.equal((await vm.runInContext("getGroupSchedule('B')",context)).lessons[0].subject,'Cached');assert.equal(calls,1,'Cached semester must work without network');
sandbox.fetch=async()=>{calls++;throw Error('Offline')};
await vm.runInContext('refreshRemote(true)',context);
assert.equal(vm.runInContext('data.tasks[0].id',context),'newer-group','Failure must retain loaded data');
assert.equal(vm.runInContext('remoteStatus',context),'error');
console.log('Client: 100 date changes = 0 requests; refresh deduplicated; stale responses ignored; cache and offline fallback passed.');

const keyPair=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
const pem='-----BEGIN PRIVATE KEY-----\n'+Buffer.from(await crypto.subtle.exportKey('pkcs8',keyPair.privateKey)).toString('base64')+'\n-----END PRIVATE KEY-----';
const env={TELEGRAM_BOT_TOKEN:'test',TEACHER_IDS:'1',GOOGLE_SHEET_ID:'test',GOOGLE_SERVICE_ACCOUNT_JSON:JSON.stringify({client_email:'test@example.com',private_key:pem})};
let metadata=0,batch=0,writes=0,oauth=0;
const originalFetch=globalThis.fetch;
globalThis.fetch=async(url,options={})=>{
 if(String(url).includes('oauth2.googleapis.com')){oauth++;return Response.json({access_token:'test',expires_in:3600})}
 if(options.method&&options.method!=='GET')writes++;
 if(String(url).includes('fields=sheets.properties')){metadata++;return Response.json({sheets:['College_Profiles','College_Tasks','College_Submissions','College_Reminders'].map(title=>({properties:{title}}))})}
 if(String(url).includes('values:batchGet')){batch++;return Response.json({valueRanges:[{values:[['2','Student','26-DCPS-01','false','now']]},{values:[['t','26-DCPS-01','Math','Homework','','2026-10-16T12:00','1','Teacher','now']]},{values:[['s','t','2','Student','my answer','','now'],['s3','t','3','Other','private other answer','','now']]}]})}
 throw Error('Unexpected Google request '+url);
};
async function signed(user){const q=new URLSearchParams({auth_date:String(Math.floor(Date.now()/1000)),user:JSON.stringify({id:user,first_name:'Test'})});const enc=new TextEncoder();async function mac(k,d){const key=await crypto.subtle.importKey('raw',typeof k==='string'?enc.encode(k):k,{name:'HMAC',hash:'SHA-256'},false,['sign']);return crypto.subtle.sign('HMAC',key,enc.encode(d))}const check=[...q.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>k+'='+v).join('\n');q.set('hash',Buffer.from(await mac(await mac('WebAppData','test'),check)).toString('hex'));return q.toString()}
try{
 const init=await signed(1);
 const responses=await Promise.all(Array.from({length:50},()=>worker.fetch(new Request('https://test/api/state?group=26-DCPS-01&date=2026-10-14',{headers:{'x-telegram-init-data':init}}),env)));
 assert.ok(responses.every(r=>r.status===200));assert.equal(metadata,1);assert.equal(batch,1);assert.equal(writes,0,'Reading existing storage must not rewrite headers');assert.equal(oauth,1);
 for(let i=0;i<100;i++){const r=await worker.fetch(new Request('https://test/api/schedule?group=26-DCPS-01'),env);assert.equal(r.status,200)}
 assert.equal(batch,1,'Public schedule must not read Google');
 const student=await worker.fetch(new Request('https://test/api/state?group=26-DCPS-01',{headers:{'x-telegram-init-data':await signed(2)}}),env);
 const state=await student.json();assert.deepEqual(state.submissions.map(s=>s.user_id),['2'],'Shared table cache must not leak other students answers');assert.equal(batch,1);
 const session=await worker.fetch(new Request('https://test/api/session',{headers:{'x-telegram-init-data':init}}),env);assert.equal(session.status,200);assert.equal(batch,1);
 console.log('Server: 50 simultaneous private reads = 1 batch read; 100 semester downloads = 0 Google reads; no header writes; identity and student isolation passed.');
}finally{globalThis.fetch=originalFetch}
