import http from 'node:http';

const defaults={upstream:process.env.ANKI_URL||'http://127.0.0.1:8765',port:Number(process.env.PORT||8766),deck:process.env.ANKI_DECK||'KanjiDamage',model:process.env.ANKI_MODEL||'KanjiDamage',origins:new Set((process.env.ALLOWED_ORIGINS||'').split(',').map(x=>x.trim()).filter(Boolean))};
const fields=['Number','Kanji','Meaning','Stroke order','Components','Onyomi','Mnemonic','Usefulness','First kunyomi','First kunyomi meaning','First kunyomi usefulness','First jukugo','First jukugo meaning','First jukugo usefulness','Full header','Description','Full onyomi','Full mnemonic','Full kunyomi','Full jukugo','Full lookalikes','Full used In','Frequency ranking'];
const safeActions=new Set(['version','deckNames','modelNames','modelFieldNames','modelTemplates','modelStyling','getProfiles','getDeckConfig','findNotes','notesInfo','cardsInfo','findCards','guiBrowse','apiReflect']);
const locks=new Map();
const protocolError=error=>({error,result:null});
const ownObject=x=>x!==null&&typeof x==='object'&&!Array.isArray(x)&&(Object.getPrototypeOf(x)===Object.prototype||Object.getPrototypeOf(x)===null);
const validKanji=s=>typeof s==='string'&&[...s].length===1&&/\p{Script=Han}/u.test(s);
const esc=s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
const toHiragana=s=>s.replace(/[ァ-ヶ]/g,c=>String.fromCharCode(c.charCodeAt(0)-0x60));
const readingNorm=s=>toHiragana(s.normalize('NFKC'));
const isKana=s=>/^[\u3041-\u3096]+$/u.test(s);

function kunMatch(reading,tail,pron){
 const r=readingNorm(reading), p=readingNorm(pron), t=readingNorm(tail);
 if(!isKana(p)) return false;
 if(r.includes('.')) { const parts=r.split('.'); if(parts.length!==2)return false;const [stem,suffix]=parts;return isKana(stem)&&isKana(suffix)&&isKana(t)&&t===suffix&&p===stem+suffix; }
 if(r.startsWith('-')) return isKana(t)&&isKana(r.slice(1))&&t===r.slice(1)&&p.endsWith(r.slice(1));
 if(r.endsWith('-')) return tail===''&&p===r.slice(0,-1);
 return tail===''?p===r:(isKana(t)&&p===r+t);
}
function classify(words,kanji,kuns,ons){
 const out={kun:[],on:[]};
 for(const word of words){
  if(!Array.isArray(word.meanings)||!Array.isArray(word.variants)) continue;
  const gloss=word.meanings.flatMap(m=>Array.isArray(m?.glosses)?m.glosses:[]).find(x=>typeof x==='string'&&x.trim());
  if(!gloss) continue;
  for(const v of word.variants){
   const {written,pronounced:pron}=v||{};
   if(typeof written!=='string'||typeof pron!=='string'||!written.startsWith(kanji)) continue;
   const tail=written.slice(kanji.length), p=readingNorm(pron);
   if([...tail].some(c=>!/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}々〆ヶ]/u.test(c))) continue;
   for(const r of kuns) if(kunMatch(r,tail,pron)) out.kun.push({written,pron,gloss});
   if([...tail].some(c=>/\p{Script=Han}/u.test(c))){
    for(const r of ons){const on=readingNorm(r);if(isKana(on)&&p.startsWith(on)&&p.length>on.length)out.on.push({written,pron,gloss});}
   }
  }
 }
 for(const k of Object.keys(out)) out[k]=[...new Map(out[k].map(x=>[x.written+'|'+x.pron,x])).values()].slice(0,3);
 return out;
}
async function fetchJson(url,init){
 const response=await fetch(url,{...init,signal:AbortSignal.timeout(8000)});
 if(!response.ok) throw Error(`HTTP ${response.status} from ${new URL(url).host}`);
 return response.json();
}
function createMiddleware({upstream=defaults.upstream,model=defaults.model,deck=defaults.deck,origins=defaults.origins,dictionaryBase='https://kanjiapi.dev/v1'}={}){
 if(typeof model!=='string'||!model.trim()||/["\\\r\n]/.test(model))throw Error('ANKI_MODEL contains characters unsafe for Anki search');
 const send=async(msg,ctx={})=>{
  const request={...msg,version:6};
  if(ctx.key!==undefined)request.key=ctx.key;else delete request.key;
  const headers={'content-type':'application/json'};
  if(ctx.origin)headers.origin=ctx.origin;
  const reply=await fetchJson(upstream,{method:'POST',headers,body:JSON.stringify(request)});
  if(!ownObject(reply)||!Object.hasOwn(reply,'result')||!Object.hasOwn(reply,'error')||(reply.error!==null&&typeof reply.error!=='string'))throw Error('Anki returned an invalid API v6 response');
  return reply;
 };
  const checkDuplicate=async(kanji,ctx)=>{
  const r=await send({action:'findNotes',version:ctx.version,params:{query:`note:"${model}" Kanji:"${kanji}"`}},ctx);
  if(r.error)throw Error(`Anki duplicate check failed: ${r.error}`);
  if(!Array.isArray(r.result)||r.result.some(id=>!Number.isSafeInteger(id)))throw Error('Anki returned an invalid duplicate-check result');
  return r.result.length>0;
 };
 const checkModel=async(ctx)=>{
  const r=await send({action:'modelFieldNames',version:ctx.version,params:{modelName:model}},ctx);
  if(r.error||!Array.isArray(r.result)||r.result.some(x=>typeof x!=='string')||fields.some(x=>!r.result.includes(x)))throw Error('Configured Anki model is missing required KanjiDamage fields');
 };
  const noteValidationError=(note)=>{
   if(!ownObject(note))return 'Note must be an object';
   if(note.modelName!==model)return `Select the configured ${model} model in Yomitan`;
   if(!ownObject(note.fields))return 'Note fields must be an object';
   if(!Object.hasOwn(note.fields,'Kanji'))return 'Map the Kanji field to {character} in Yomitan’s kanji-card settings';
   for(const [name,value] of Object.entries(note.fields))if(typeof value!=='string')return fields.includes(name)?`Field “${name}” must be a string`:'A note field must be a string';
   if(note.fields.Kanji.trim().length===0)return 'Map the Kanji field to {character} in Yomitan’s kanji-card settings; it must not be blank';
   const count=[...note.fields.Kanji].length;
   if(!validKanji(note.fields.Kanji))return `Kanji must be exactly one Han ideograph (received ${count} ${count===1?'character':'characters'})`;
   return null;
  };
  const preflight=async(notes,detailed,ctx)=>{
   if(!Array.isArray(notes))return protocolError('notes must be an array');
   if(notes.every(note=>ownObject(note)&&typeof note.modelName==='string'&&note.modelName!==model))return send({action:ctx.action,version:ctx.version,params:ctx.params},ctx);
   const result=[];
   let modelChecked=false,modelError;
   for(const note of notes){
      if(ownObject(note)&&typeof note.modelName==='string'&&note.modelName!==model){
      try{const r=await send({action:detailed?'canAddNotesWithErrorDetail':'canAddNotes',version:ctx.version,params:{...ctx.params,notes:[note]}},ctx);if(r.error)throw Error(r.error);const item=r.result?.[0];result.push(item??(detailed?{canAdd:false,error:'Anki returned an invalid preflight result'}:false));}
      catch(e){result.push(detailed?{canAdd:false,error:e.message}:false);}
      continue;
     }
      const validationError=noteValidationError(note);
      if(validationError){result.push(detailed?{canAdd:false,error:validationError}:false);continue;}
      if(!modelChecked){modelChecked=true;try{await checkModel(ctx);}catch(e){modelError=e.message;}}
      if(modelError){result.push(detailed?{canAdd:false,error:modelError}:false);continue;}
     try{const duplicate=await checkDuplicate(note.fields.Kanji,ctx);result.push(detailed?{canAdd:!duplicate,error:duplicate?'A note for this kanji already exists in the configured model':null}:!duplicate);}
   catch(e){result.push(detailed?{canAdd:false,error:e.message}:false);}
  }
  return {result,error:null};
 };
 const enrich=async(kanji)=>{
  const [info,words]=await Promise.all([fetchJson(`${dictionaryBase}/kanji/${encodeURIComponent(kanji)}`),fetchJson(`${dictionaryBase}/words/${encodeURIComponent(kanji)}`)]);
  if(!ownObject(info)||!Array.isArray(info.meanings)||!info.meanings.length||info.meanings.some(x=>typeof x!=='string'||!x.trim())||!Array.isArray(info.kun_readings)||info.kun_readings.some(x=>typeof x!=='string'||!x.trim())||!Array.isArray(info.on_readings)||info.on_readings.some(x=>typeof x!=='string'||!x.trim())||!Array.isArray(words))throw Error('Dictionary returned malformed kanji or word data');
  const examples=classify(words,kanji,info.kun_readings,info.on_readings);
  if(info.kun_readings.length&&!examples.kun.length)throw Error('No verifiable kun’yomi example is available; no card was created');
  if(info.on_readings.length&&!examples.on.length)throw Error('No verifiable on’yomi example is available; no card was created');
  const fmt=a=>a.map(x=>`${esc(x.written)}（${esc(x.pron)}）— ${esc(x.gloss)}`).join('<br>');
  const kun=examples.kun[0],on=examples.on[0], meanings=info.meanings.map(esc).join('; ');
  return {Kanji:kanji,Meaning:meanings,Onyomi:info.on_readings.map(esc).join('、'),'First kunyomi':kun?`${esc(kun.written)}（${esc(kun.pron)}）`:'','First kunyomi meaning':kun?esc(kun.gloss):'','First jukugo':on?`${esc(on.written)}（${esc(on.pron)}）`:'','First jukugo meaning':on?esc(on.gloss):'','Full header':`<b>${esc(kanji)} — ${meanings}</b>`,'Full onyomi':info.on_readings.map(esc).join('、'),'Full kunyomi':fmt(examples.kun),'Full jukugo':fmt(examples.on),Description:'Source: <a href="https://kanjiapi.dev/">KanjiAPI.dev</a> (KANJIDIC/JMdict data).',Mnemonic:'','Full mnemonic':''};
 };
 const create=async(note,ctx)=>{
  await checkModel(ctx);
  const kanji=note.fields.Kanji;
  if(await checkDuplicate(kanji,ctx))throw Error('A note for this kanji already exists in the configured model');
  const enriched=await enrich(kanji);
  const merged={...note.fields,...enriched,Mnemonic:'','Full mnemonic':''};
  for(const name of fields)if(!(name in merged))merged[name]='';
  const outgoing={...note,deckName:note.deckName||deck,modelName:model,fields:merged,options:{...(ownObject(note.options)?note.options:{}),allowDuplicate:false}};
  if(await checkDuplicate(kanji,ctx))throw Error('A note for this kanji already exists in the configured model');
  const result=await send({action:'addNote',version:ctx.version,params:{...ctx.params,note:outgoing}},ctx);
  if(result.error)throw Error(`Anki add failed: ${result.error}`);
  if(!Number.isSafeInteger(result.result))throw Error('Anki returned an invalid addNote result; check Anki before retrying');
  return result;
 };
 const dispatch=async(msg,ctx={})=>{
  if(!ownObject(msg)||!Number.isInteger(msg.version)||typeof msg.action!=='string'||(msg.params!==undefined&&!ownObject(msg.params)))return protocolError('Invalid AnkiConnect request');
   ctx={...ctx,action:msg.action,version:msg.version,key:msg.key,params:msg.params||{}};
  if(msg.action==='multi'){
   const actions=msg.params?.actions;
   if(!Array.isArray(actions)||actions.length>50)return protocolError('multi requires at most 50 actions');
   const results=[];
   for(const action of actions){
    if(!ownObject(action)||action.action==='multi'||action.action==='addNote'||action.action==='addNotes')return protocolError('multi supports read-only actions only');
    const child={...action,version:Number.isInteger(action.version)?action.version:4};
    if(child.key===undefined&&ctx.key!==undefined)child.key=ctx.key;
    const reply=await dispatch(child,{origin:ctx.origin});
    results.push(reply.error===null?(child.version<=4?reply.result:reply):reply);
   }
   return {result:results,error:null};
  }
  if(msg.action==='addNotes')return protocolError('Batch/multi actions are not supported by this middleware');
   if(msg.action==='canAddNotes'||msg.action==='canAddNotesWithErrorDetail')return preflight(msg.params?.notes,msg.action==='canAddNotesWithErrorDetail',ctx);
    if(msg.action==='findNotes')return send(msg,ctx);
   if(msg.action==='addNote'){
    const note=msg.params?.note;
    if(ownObject(note)&&typeof note.modelName==='string'&&note.modelName!==model)return send(msg,ctx);
    const validationError=noteValidationError(note);
    if(validationError)return protocolError(validationError);
   const kanji=note.fields.Kanji,previous=locks.get(kanji)||Promise.resolve();
   const current=previous.then(()=>create(note,ctx)).catch(e=>protocolError(e.message));locks.set(kanji,current);
   try{return await current;}finally{if(locks.get(kanji)===current)locks.delete(kanji);}
  }
  if(!safeActions.has(msg.action))return protocolError('This AnkiConnect action is not exposed by the middleware');
  return send(msg,ctx);
 };
 const server=http.createServer(async(req,res)=>{
  const origin=req.headers.origin,host=req.headers.host||'';
  if(!(host==='localhost'||host.startsWith('localhost:')||host==='127.0.0.1'||host.startsWith('127.0.0.1:')||host==='[::1]'||host.startsWith('[::1]:'))){res.writeHead(403).end();return;}
  if(origin&&!origins.has(origin)){res.writeHead(403).end();return;}
  if(origin){res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin');res.setHeader('Access-Control-Allow-Headers','Content-Type');res.setHeader('Access-Control-Allow-Methods','POST, OPTIONS');}
  if(req.method==='OPTIONS'){res.writeHead(origin?204:403).end();return;}
  if(req.method!=='POST'||req.url!=='/'){res.writeHead(404).end();return;}
  let body='',bytes=0,tooLarge=false;req.setTimeout(5000,()=>req.destroy());
  req.on('data',chunk=>{bytes+=chunk.length;if(bytes>1_000_000){tooLarge=true;req.destroy();return;}body+=chunk;});
  req.on('end',async()=>{if(tooLarge)return;try{const msg=JSON.parse(body);const reply=await dispatch(msg,{origin});const bodyOut=reply.error===null&&msg.version<=4?reply.result:reply;res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify(bodyOut));}catch(e){if(!res.destroyed)res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify(protocolError(e.message)));}});
 });
 return {server,dispatch,enrich:enrich.bind(null),classify,fields};
}
const middleware=createMiddleware();
if(process.argv[1]&&new URL(import.meta.url).href===new URL(`file://${process.argv[1]}`).href)middleware.server.listen(defaults.port,'127.0.0.1',()=>console.log(`KanjiDamage middleware listening on 127.0.0.1:${defaults.port}`));
export const {server,dispatch,enrich}=middleware;
export {classify,createMiddleware,fields};
