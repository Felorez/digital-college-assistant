const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}});
const enc=new TextEncoder();
const hex=b=>Array.from(new Uint8Array(b),x=>x.toString(16).padStart(2,'0')).join('');
const b64=b=>btoa(String.fromCharCode(...new Uint8Array(b))).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
async function hmac(key,data){const k=await crypto.subtle.importKey('raw',typeof key==='string'?enc.encode(key):key,{name:'HMAC',hash:'SHA-256'},false,['sign']);return crypto.subtle.sign('HMAC',k,enc.encode(data));}
function equal(a,b){if(a.length!==b.length)return false;let v=0;for(let i=0;i<a.length;i++)v|=a.charCodeAt(i)^b.charCodeAt(i);return v===0;}
async function identity(req,env){
 const init=req.headers.get('x-telegram-init-data')||'';
 if(init.length>12000)throw new Error('401:Откройте приложение через Telegram');
 const q=new URLSearchParams(init), hash=q.get('hash')||'';
 if([...q.keys()].length!==new Set(q.keys()).size)throw new Error('401:Неверная авторизация');
 q.delete('hash');
 const check=[...q.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>k+'='+v).join('\n');
 if(!env.TELEGRAM_BOT_TOKEN || !equal(hex(await hmac(await hmac('WebAppData',env.TELEGRAM_BOT_TOKEN),check)),hash))throw new Error('401:Откройте приложение через кнопку бота');
 const age=Date.now()/1000-Number(q.get('auth_date'));
 if(!Number.isFinite(age)||age< -60||age>86400)throw new Error('401:Закройте и заново откройте приложение');
 const u=JSON.parse(q.get('user')||'{}');
 if(!Number.isSafeInteger(u.id))throw new Error('401:Не удалось определить пользователя');
 return {id:String(u.id),name:String(u.first_name||'Пользователь').slice(0,80),role:(env.TEACHER_IDS||'').split(',').includes(String(u.id))?'teacher':'student'};
}
let tokenCache=null;
async function googleToken(env){
 if(tokenCache && tokenCache.expires>Date.now()+60000)return tokenCache.value;
 const sa=JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON||'{}');
 if(!sa.private_key)throw new Error('503:Не настроено хранилище колледжа');
 const now=Math.floor(Date.now()/1000);
 const header=b64(enc.encode(JSON.stringify({alg:'RS256',typ:'JWT'})));
 const body=b64(enc.encode(JSON.stringify({iss:sa.client_email,scope:'https://www.googleapis.com/auth/spreadsheets',aud:'https://oauth2.googleapis.com/token',iat:now,exp:now+3600})));
 const pem=sa.private_key.replace(/-----[^-]+-----/g,'').replace(/\s/g,'');
 const key=await crypto.subtle.importKey('pkcs8',Uint8Array.from(atob(pem),c=>c.charCodeAt(0)),{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['sign']);
 const assertion=header+'.'+body+'.'+b64(await crypto.subtle.sign('RSASSA-PKCS1-v1_5',key,enc.encode(header+'.'+body)));
 const r=await fetch('https://oauth2.googleapis.com/token',{method:'POST',body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion})});
 if(!r.ok)throw new Error('503:Не удалось подключить Google Таблицу');
 const data=await r.json();tokenCache={value:data.access_token,expires:Date.now()+data.expires_in*1000};return tokenCache.value;
}
async function google(env,path,method='GET',body){
 const r=await fetch('https://sheets.googleapis.com/v4/spreadsheets/'+env.GOOGLE_SHEET_ID+path,{method,headers:{authorization:'Bearer '+await googleToken(env),'content-type':'application/json'},body:body?JSON.stringify(body):undefined});
 if(!r.ok)throw new Error('503:Google временно недоступен. Повторите позже.');
 return r.json();
}
const tabs={
 'College_Profiles':['user_id','name','group','reminders','updated'],
 'College_Tasks':['id','group','subject','title','details','due','teacher_id','teacher_name','created'],
 'College_Submissions':['id','task_id','user_id','name','answer','link','created'],
 'College_Reminders':['key','sent_at']
};
let initialized=false,setupPromise=null;
async function setup(env){
 if(initialized)return;
 if(setupPromise)return setupPromise;
 setupPromise=(async()=>{
 const meta=await google(env,'?fields=sheets.properties');
 const names=new Set(meta.sheets.map(x=>x.properties.title));
 const missing=Object.keys(tabs).filter(t=>!names.has(t));
 const requests=missing.map(title=>({addSheet:{properties:{title,gridProperties:{rowCount:10000,columnCount:12,frozenRowCount:1}}}}));
 if(requests.length)await google(env,':batchUpdate','POST',{requests});
 for(const title of missing)await google(env,'/values/'+encodeURIComponent("'"+title+"'!A1")+'?valueInputOption=RAW','PUT',{values:[tabs[title]]});
 initialized=true;
 })();
 try{await setupPromise;}finally{setupPromise=null;}
}
const tableCache=new Map(),tableFlights=new Map();let stateFlight=null,storageEpoch=0;
const tableKey=(env,tab)=>env.GOOGLE_SHEET_ID+':'+tab;
const decodeRows=(tab,values)=>(values||[]).map(r=>Object.fromEntries(tabs[tab].map((key,i)=>[key,r[i]??''])));
async function rows(env,tab){
 const key=tableKey(env,tab),cached=tableCache.get(key);
 if(cached&&Date.now()-cached.time<30000)return cached.data;
 if(tableFlights.has(key))return tableFlights.get(key);
 const epoch=storageEpoch;
 const flight=(async()=>{const d=await google(env,'/values/'+encodeURIComponent("'"+tab+"'!A2:L10000"));const data=decodeRows(tab,d.values);if(epoch===storageEpoch)tableCache.set(key,{data,time:Date.now()});return data})();
 tableFlights.set(key,flight);try{return await flight}finally{tableFlights.delete(key)}
}
async function stateTables(env){
 const names=['College_Profiles','College_Tasks','College_Submissions'];
 if(names.every(t=>{const c=tableCache.get(tableKey(env,t));return c&&Date.now()-c.time<30000}))return names.map(t=>tableCache.get(tableKey(env,t)).data);
 if(stateFlight)return stateFlight;
 const epoch=storageEpoch;
 stateFlight=(async()=>{const query=names.map(t=>'ranges='+encodeURIComponent("'"+t+"'!A2:L10000")).join('&');const d=await google(env,'/values:batchGet?'+query);return names.map((tab,i)=>{const data=decodeRows(tab,d.valueRanges?.[i]?.values);if(epoch===storageEpoch)tableCache.set(tableKey(env,tab),{data,time:Date.now()});return data})})();
 try{return await stateFlight}finally{stateFlight=null}
}
async function append(env,tab,row){
 const result=await google(env,'/values/'+encodeURIComponent("'"+tab+"'!A:L")+':append?valueInputOption=RAW&insertDataOption=INSERT_ROWS','POST',{values:[row]});
 storageEpoch++;tableCache.delete(tableKey(env,tab));return result;
}
const localDate=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Almaty',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
function schedule(group,date){
 if(!/^\d{4}-\d{2}-\d{2}$/.test(date))throw new Error('400:Неверная дата');
 const d=new Date(date+'T00:00:00Z');if(!Number.isFinite(+d)||d.toISOString().slice(0,10)!==date)throw new Error('400:Неверная дата');
 const week=Math.floor((+d-+new Date(SCHEDULE.semesterStart+'T00:00:00Z'))/604800000)+1;
 const day=(d.getUTCDay()+6)%7;
 const lessons=date<SCHEDULE.semesterStart||date>SCHEDULE.semesterEnd?[]:SCHEDULE.lessons.filter(l=>l.group===group&&l.day===day&&l.weeks.includes(week));
 return {date,week,lessons};
}
function validGroup(group){if(!SCHEDULE.groups.some(g=>g.id===group))throw new Error('400:Выберите группу из расписания');return group;}
function text(value,max=300){return typeof value==='string'?value.trim().slice(0,max):'';}
function dueDate(value){const s=text(value,20);if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s)||!Number.isFinite(Date.parse(s+':00+05:00')))throw new Error('400:Укажите дату и время сдачи');return s;}
async function state(env,u,group,date){
 await setup(env);
 const [profiles,allTasks,allSubs]=await stateTables(env);
 const profile=profiles.filter(p=>p.user_id===u.id).at(-1)||{group:'',reminders:'false'};
 group=validGroup(group||profile.group||'26-DCPS-01');
 const tasks=allTasks.filter(t=>t.group===group);
 const ids=new Set(tasks.map(t=>t.id));
 const submissions=allSubs.filter(s=>ids.has(s.task_id)&&(u.role==='teacher'||s.user_id===u.id));
 return {user:u,profile,group,groups:SCHEDULE.groups,status:SCHEDULE.status,sourceName:SCHEDULE.sourceName,
         semesterStart:SCHEDULE.semesterStart,semesterEnd:SCHEDULE.semesterEnd,...schedule(group,date||localDate()),tasks,submissions,syncedAt:new Date().toISOString()};
}
async function createTask(env,u,b){
 if(u.role!=='teacher')throw new Error('403:Создавать задания может только преподаватель');
 const group=validGroup(b.group), title=text(b.title,200),subject=text(b.subject,120), details=text(b.details,5000), due=dueDate(b.due);
 if(!title||!subject)throw new Error('400:Укажите предмет и название задания');
 const id=text(b.request_id,100)||crypto.randomUUID();
 if(!/^[a-zA-Z0-9_-]{1,100}$/.test(id))throw new Error('400:Неверный идентификатор');
 const old=(await rows(env,'College_Tasks')).find(t=>t.id===id);
 if(old){if(old.teacher_id!==u.id)throw new Error('409:Идентификатор уже занят');return old;}
 const now=new Date().toISOString();
 await append(env,'College_Tasks',[id,group,subject,title,details,due,u.id,u.name,now]);
 return {id,group,subject,title,details,due,teacher_id:u.id,teacher_name:u.name,created:now};
}
export default {async fetch(req,env){
 try{
  const url=new URL(req.url),p=url.pathname;
  if(p==='/' && req.method==='GET')return new Response(PAGE,{headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-cache','x-content-type-options':'nosniff','referrer-policy':'no-referrer'}});
  if(p==='/api/health')return json({ok:true,version:'college-1',groups:SCHEDULE.groups.length});
  if(p==='/api/catalog')return new Response(JSON.stringify({version:SCHEDULE_VERSION,groups:SCHEDULE.groups,
       status:SCHEDULE.status,sourceName:SCHEDULE.sourceName,semesterStart:SCHEDULE.semesterStart,semesterEnd:SCHEDULE.semesterEnd}),
       {headers:{'content-type':'application/json; charset=utf-8','cache-control':'public,max-age=300'}});
  if(p==='/api/schedule'){
   const group=validGroup(url.searchParams.get('group'));
   return new Response(JSON.stringify({version:SCHEDULE_VERSION,group,lessons:SCHEDULE.lessons.filter(l=>l.group===group).map(({raw,...lesson})=>lesson)}),
      {headers:{'content-type':'application/json; charset=utf-8','cache-control':'public,max-age=86400','etag':'"'+SCHEDULE_VERSION+'-'+encodeURIComponent(group)+'"'}});
  }
  if(p==='/api/session'&&req.method==='GET')return json({user:await identity(req,env)});
  if(p==='/api/demo'){
   const group=validGroup(url.searchParams.get('group')||'26-DCPS-01');
   return json({demo:true,user:{id:'demo',name:'Демонстрация',role:'teacher'},group,groups:SCHEDULE.groups,
    status:SCHEDULE.status,sourceName:SCHEDULE.sourceName,profile:{group,reminders:'false'},tasks:[],submissions:[],
    semesterStart:SCHEDULE.semesterStart,semesterEnd:SCHEDULE.semesterEnd,...schedule(group,url.searchParams.get('date')||localDate())});
  }
  if(p.startsWith('/api/bot/')){
   const auth=req.headers.get('authorization')||'';
   if(!env.BOT_SERVICE_SECRET||!equal(auth,'Bearer '+env.BOT_SERVICE_SECRET))throw new Error('401:Доступ закрыт');
   await setup(env);
   const b=await req.json(),u={id:String(b.user_id),name:text(b.name,80)||'Пользователь',role:(env.TEACHER_IDS||'').split(',').includes(String(b.user_id))?'teacher':'student'};
   if(p==='/api/bot/state')return json(await state(env,u,b.group,b.date));
   if(p==='/api/bot/task')return json(await createTask(env,u,b));
   if(p==='/api/bot/profile'){
    const group=validGroup(b.group);await append(env,'College_Profiles',[u.id,u.name,group,'false',new Date().toISOString()]);return json({ok:true,group});
   }
   if(p==='/api/bot/reminders'){
    const [profiles,tasks,sent]=await Promise.all([rows(env,'College_Profiles'),rows(env,'College_Tasks'),rows(env,'College_Reminders')]);
    const latest=new Map(profiles.map(p=>[p.user_id,p]));const keys=new Set(sent.map(s=>s.key)),due=[];
    for(const profile of latest.values())if(profile.reminders==='true')for(const task of tasks){
     const remaining=Date.parse(task.due+':00+05:00')-Date.now(),key=task.id+':'+profile.user_id+':24h';
     if(remaining>0&&remaining<=86400000&&!keys.has(key))due.push({key,user_id:profile.user_id,task});
    }return json({reminders:due.slice(0,100)});
   }
   if(p==='/api/bot/reminder-sent'){await append(env,'College_Reminders',[text(b.key,200),new Date().toISOString()]);return json({ok:true});}
   return json({error:'Не найдено'},404);
  }
  if(!p.startsWith('/api/'))return new Response('Не найдено',{status:404});
  const u=await identity(req,env);await setup(env);
  if(p==='/api/state'&&req.method==='GET')return json(await state(env,u,url.searchParams.get('group'),url.searchParams.get('date')));
  if(req.method!=='POST')return json({error:'Метод не поддерживается'},405);
  if(Number(req.headers.get('content-length')||'0')>20000)throw new Error('413:Запрос слишком большой');
  const raw=await req.text();if(raw.length>20000)throw new Error('413:Запрос слишком большой');const b=JSON.parse(raw);
  if(p==='/api/profile'){
   const group=validGroup(b.group);await append(env,'College_Profiles',[u.id,u.name,group,b.reminders===true?'true':'false',new Date().toISOString()]);return json({ok:true});
  }
  if(p==='/api/tasks')return json(await createTask(env,u,b),201);
  if(p==='/api/submit'){
   const task=(await rows(env,'College_Tasks')).find(t=>t.id===b.task_id);
   const profile=(await rows(env,'College_Profiles')).filter(x=>x.user_id===u.id).at(-1);
   if(!task||!profile||task.group!==profile.group)throw new Error('403:Задание недоступно для вашей группы');
   const answer=text(b.answer,5000),link=text(b.link,1500);
   if(!answer&&!link)throw new Error('400:Добавьте ответ или ссылку на работу');
   if(link&&!/^https:\/\//i.test(link))throw new Error('400:Ссылка должна начинаться с https://');
   await append(env,'College_Submissions',[crypto.randomUUID(),task.id,u.id,u.name,answer,link,new Date().toISOString()]);return json({ok:true});
  }
  return json({error:'Не найдено'},404);
 }catch(e){const m=/^(\d{3}):(.*)$/s.exec(e.message||'');return json({error:m?m[2]:'Не удалось выполнить действие. Повторите позже.'},m?Number(m[1]):500);}
}};
export {identity,schedule};
