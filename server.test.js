import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createMiddleware,fields,classify} from './server.js';

const origin='chrome-extension://test-extension';
const wordsFor日=[
 {meanings:[{glosses:['<img src=x onerror=alert(1)>']}],variants:[{written:'日にち',pronounced:'ひにち'}]},
 {meanings:[{glosses:['daily life']}],variants:[{written:'日常',pronounced:'にちじょう'}]},
 {meanings:[{glosses:['false positive']}],variants:[{written:'休日',pronounced:'きゅうじつ'}]},
];
const wordsFor食=[
 {meanings:[{glosses:['to eat']}],variants:[{written:'食べる',pronounced:'たべる'}]},
 {meanings:[{glosses:['meal']}],variants:[{written:'食事',pronounced:'しょくじ'}]},
 {meanings:[{glosses:['false single-kanji word']}],variants:[{written:'食べる',pronounced:'しょくべる'}]},
];
const kanjiInfo={日:{meanings:['day','sun'],kun_readings:['ひ','-び','-か'],on_readings:['ニチ','ジツ']},食:{meanings:['eat','food'],kun_readings:['く.う','く.らう','た.べる','は.む'],on_readings:['ショク','ジキ']}};
async function listen(server){await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));return `http://127.0.0.1:${server.address().port}`;}
async function close(server){await new Promise(resolve=>server.close(resolve));}
async function fixture({duplicate=false,failEnrichment=false,badFind=false,badModel=false}={}){
 const upstreamCalls=[],created=[];let exists=duplicate;
 const upstream=http.createServer(async(req,res)=>{let body='';for await(const c of req)body+=c;const msg=JSON.parse(body);upstreamCalls.push({msg,origin:req.headers.origin});let result;
  if(msg.version!==6)throw Error(`expected AnkiConnect v6, got ${msg.version}`);
   if(msg.action==='version')result=6;
   else if(msg.action==='canAddNotes')result=msg.params.notes.map(()=>true);
   else if(msg.action==='canAddNotesWithErrorDetail')result=msg.params.notes.map(()=>({canAdd:true,error:null}));
    else if(msg.action==='modelFieldNames')result=badModel?['Number','Kanji']:['Number',...fields.filter(x=>x!=='Number')];
   else if(msg.action==='findNotes')result=badFind?'not an ID array':exists?[17]:[];
  else if(msg.action==='addNote'){
   assert(Object.values(msg.params.note.fields).every(x=>typeof x==='string'),'Anki note fields must be strings');
    if(msg.params.note.modelName==='KanjiDamage')assert.equal(msg.params.note.options.allowDuplicate,false);created.push(msg.params.note);exists=true;result=101;
  } else result=[];
  res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({result,error:null}));
 });
 const upstreamUrl=await listen(upstream);
 const dictionary=http.createServer((req,res)=>{
  assert.equal(req.headers['anki-key'],undefined);
  assert.equal(req.headers.origin,undefined);
  const k=decodeURIComponent(req.url.split('/').at(-1));
  if(failEnrichment){res.writeHead(503).end('failure');return;}
  const data=req.url.includes('/kanji/')?kanjiInfo[k]:k==='食'?wordsFor食:wordsFor日;
  res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify(data));
 });
 const dictionaryUrl=await listen(dictionary);
 const middleware=createMiddleware({upstream:upstreamUrl,model:'KanjiDamage',deck:'KanjiDamage',origins:new Set([origin]),dictionaryBase:dictionaryUrl+'/v1'});
 const proxyUrl=await listen(middleware.server);
 return {upstreamCalls,created,upstream,dictionary,middleware,proxyUrl,cleanup:async()=>{await close(middleware.server);await close(dictionary);await close(upstream);}};
}
async function post(url,msg,headers={}){
 return fetch(url,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(msg)}).then(r=>r.json());
}
async function requestWithHost(url,host){return new Promise((resolve,reject)=>{const u=new URL(url),r=http.request({hostname:u.hostname,port:u.port,path:'/',method:'OPTIONS',headers:{origin,host}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});r.on('error',reject);r.end();});}
const note=(kanji='日')=>({deckName:'KanjiDamage',modelName:'KanjiDamage',fields:{Kanji:kanji,Mnemonic:'ignore this', 'Full mnemonic':'ignore this',Meaning:'template value',Number:'3'}});

test('classifies live-shape 食 and 日 examples conservatively',()=>{
 const day=classify(wordsFor日,'日',kanjiInfo.日.kun_readings,kanjiInfo.日.on_readings);
 assert(day.kun.some(x=>x.written==='日にち'));
 assert(day.on.some(x=>x.written==='日常'));
 assert(!day.on.some(x=>x.written==='休日'));
 const food=classify(wordsFor食,'食',kanjiInfo.食.kun_readings,kanjiInfo.食.on_readings);
 assert(food.kun.some(x=>x.written==='食べる'));
 assert(food.on.some(x=>x.written==='食事'));
 assert(!food.on.some(x=>x.written==='食べる'));
});
test('configured model cannot inject Anki search syntax',()=>{
 assert.throws(()=>createMiddleware({model:'KanjiDamage" OR deck:*'}),/unsafe for Anki search/);
});
test('Yomitan v2 addNote receives a naked result while upstream uses v6 envelopes',async t=>{
 const f=await fixture();t.after(f.cleanup);
 const reply=await post(f.proxyUrl,{action:'addNote',version:2,key:'secret-test-key',params:{note:note() }},{origin});
 assert.equal(reply,101);assert.equal(f.created.length,1);
 const stored=f.created[0];assert(Object.values(stored.fields).every(v=>typeof v==='string'));
 assert.equal(stored.fields.Mnemonic,'');assert.equal(stored.fields['Full mnemonic'],'');
 assert.equal(stored.fields.Meaning,'day; sun');assert.equal(stored.fields['First kunyomi'],'日にち（ひにち）');
 assert.match(stored.fields['First kunyomi meaning'],/&lt;img src=x onerror=alert\(1\)&gt;/);
 assert.equal(stored.fields['First jukugo'],'日常（にちじょう）');assert.equal(stored.fields.Number,'3');
 assert.equal(f.upstreamCalls.every(x=>x.msg.key==='secret-test-key'&&x.msg.version===6&&x.origin===origin),true);
 const duplicate=await post(f.proxyUrl,{action:'addNote',version:2,key:'secret-test-key',params:{note:note()}},{origin});
 assert.equal(duplicate.result,null);assert.match(duplicate.error,/already exists/);
});
test('v6 callers receive envelopes and version reports the real upstream version',async t=>{
 const f=await fixture();t.after(f.cleanup);
 assert.deepEqual(await post(f.proxyUrl,{action:'version',version:6},{origin}),{result:6,error:null});
 const result=await post(f.proxyUrl,{action:'canAddNotes',version:6,params:{notes:[note()]}},{origin});
 assert.deepEqual(result,{result:[true],error:null});
});
test('read-only multi runs bounded allowlisted children and returns legacy child results',async t=>{
 const f=await fixture({duplicate:true});t.after(f.cleanup);
 const reply=await post(f.proxyUrl,{action:'multi',version:2,key:'multi-key',params:{actions:[{action:'findNotes',params:{query:'Kanji:"日"'}},{action:'modelNames',params:{}}]}},{origin});
 assert.deepEqual(reply,[[17],[]]);
 assert.equal(f.upstreamCalls.every(x=>x.msg.action!=='multi'&&x.msg.version===6&&x.msg.key==='multi-key'&&x.origin===origin),true);
 assert.deepEqual(await post(f.proxyUrl,{action:'multi',version:6,params:{actions:[{action:'findNotes',params:{query:''}}]}},{origin}),{result:[[17]],error:null});
 assert.match((await post(f.proxyUrl,{action:'multi',version:2,params:{actions:[{action:'addNote',params:{}}]}},{origin})).error,/read-only/);
});
test('canAdd preflight checks target duplicates without dictionary access',async t=>{
 const f=await fixture({duplicate:true});t.after(f.cleanup);
 assert.deepEqual(await post(f.proxyUrl,{action:'canAddNotes',version:6,params:{notes:[note()]}},{origin}),{result:[false],error:null});
  assert.deepEqual(await post(f.proxyUrl,{action:'canAddNotesWithErrorDetail',version:6,params:{notes:[note('日')]}},{origin}),{result:[{canAdd:false,error:'A note for this kanji already exists in the configured model'}],error:null});
 assert.equal(f.upstreamCalls.filter(x=>x.msg.action==='findNotes').length,2);assert.equal(f.created.length,0);
});
test('model field order and note lookups pass through unchanged',async t=>{
 const f=await fixture({duplicate:true});t.after(f.cleanup);
 const model=await post(f.proxyUrl,{action:'modelFieldNames',version:6,params:{modelName:'KanjiDamage'}},{origin});
  assert.equal(model.result[0],'Number');
 assert.deepEqual(f.upstreamCalls.find(x=>x.msg.action==='modelFieldNames').msg.params,{modelName:'KanjiDamage'});
  assert.deepEqual(await post(f.proxyUrl,{action:'modelFieldNames',version:6,params:{modelName:'Other'}},{origin}),{result:['Number',...fields.filter(x=>x!=='Number')],error:null});
 const yomitanNote={...note(),fields:{Kanji:'日'}};
 const preflight=await post(f.proxyUrl,{action:'canAddNotesWithErrorDetail',version:2,params:{notes:[yomitanNote]}},{origin});
  assert.deepEqual(preflight,[{canAdd:false,error:'A note for this kanji already exists in the configured model'}]);
 const ids=await post(f.proxyUrl,{action:'findNotes',version:2,params:{query:'"kanji:日"'}},{origin});
  assert.deepEqual(ids,[17]);
 assert.equal(f.upstreamCalls.some(x=>x.msg.action==='addNote'),false);
  assert.equal(f.upstreamCalls.some(x=>x.msg.action==='findNotes'&&x.msg.params.query==='"kanji:日"'),true);
 await post(f.proxyUrl,{action:'findNotes',version:6,params:{query:'"deck:KanjiDamage" "kanji:日"'}},{origin});
  assert.equal(f.upstreamCalls.at(-1).msg.params.query,'"deck:KanjiDamage" "kanji:日"');
 await post(f.proxyUrl,{action:'findNotes',version:6,params:{query:'deck:"Default"'}},{origin});
 assert.equal(f.upstreamCalls.at(-1).msg.params.query,'deck:"Default"');
});
test('duplicate preflight returns the explicit KanjiDamage error in v6',async t=>{
 const f=await fixture({duplicate:true});t.after(f.cleanup);
 const duplicate=await post(f.proxyUrl,{action:'canAddNotesWithErrorDetail',version:6,params:{notes:[{...note(),fields:{Kanji:'日'}}]}},{origin});
  assert.deepEqual(duplicate,{result:[{canAdd:false,error:'A note for this kanji already exists in the configured model'}],error:null});
 const cleanFixture=await fixture();t.after(cleanFixture.cleanup);
 const clean=await post(cleanFixture.proxyUrl,{action:'canAddNotesWithErrorDetail',version:6,params:{notes:[{...note('食'),fields:{Kanji:'食'}}]}},{origin});
 assert.deepEqual(clean,{result:[{canAdd:true,error:null}],error:null});
});
test('non-KanjiDamage vocabulary notes pass through unchanged, including preflight',async t=>{
 const f=await fixture();t.after(f.cleanup);
 const vocabulary={deckName:'Core 2k/6k Optimized Japanese Vocabulary',modelName:'Japanese Vocabulary',fields:{Word:'践む',Reading:'ふむ',Meaning:'to step on',Mnemonic:'keep this content'},tags:['custom'],options:{allowDuplicate:true},customParam:'preserve'};
 for(const [word,fields] of [['践む',vocabulary.fields],['漢字熟語',{...vocabulary.fields,Word:'漢字熟語'}],['日',{...vocabulary.fields,Word:'日'}]]){
  const note={...vocabulary,fields:{...fields,Word:word}};
  const added=await post(f.proxyUrl,{action:'addNote',version:6,key:'vocab-key',params:{note,customParam:'outer'}},{origin});
  assert.deepEqual(added,{result:101,error:null});
  assert.deepEqual(f.upstreamCalls.at(-1).msg.params,{note,customParam:'outer'});
 }
 const batch=[vocabulary,{...vocabulary,fields:{...vocabulary.fields,Word:'漢字熟語'}}];
 assert.deepEqual(await post(f.proxyUrl,{action:'canAddNotesWithErrorDetail',version:6,params:{notes:batch}},{origin}),{result:[{canAdd:true,error:null},{canAdd:true,error:null}],error:null});
 assert.deepEqual(f.upstreamCalls.at(-1).msg,{action:'canAddNotesWithErrorDetail',version:6,params:{notes:batch}});
 assert.equal(f.upstreamCalls.some(x=>['modelFieldNames','findNotes'].includes(x.msg.action)),false);
});
test('mixed preflight keeps vocabulary results when KanjiDamage schema validation fails',async t=>{
 const f=await fixture({badModel:true});t.after(f.cleanup);
 const vocabulary={deckName:'Core 2k/6k Optimized Japanese Vocabulary',modelName:'Japanese Vocabulary',fields:{Word:'践む'}};
 const target=note();
 const result=await post(f.proxyUrl,{action:'canAddNotesWithErrorDetail',version:6,params:{notes:[vocabulary,target,vocabulary]}},{origin});
 assert.deepEqual(result,{result:[{canAdd:true,error:null},{canAdd:false,error:'Configured Anki model is missing required KanjiDamage fields'},{canAdd:true,error:null}],error:null});
 const calls=f.upstreamCalls.filter(x=>x.msg.action==='canAddNotesWithErrorDetail');
 assert.equal(calls.length,2);
 assert.deepEqual(calls.map(x=>x.msg.params.notes),[[vocabulary],[vocabulary]]);
});
test('configured KanjiDamage field order and duplicate lookup remain transparent',async t=>{
 const f=await fixture({duplicate:true});t.after(f.cleanup);
 assert.deepEqual(await post(f.proxyUrl,{action:'modelFieldNames',version:6,params:{modelName:'KanjiDamage'}},{origin}),{result:['Number',...fields.filter(x=>x!=='Number')],error:null});
 await post(f.proxyUrl,{action:'findNotes',version:6,params:{query:'"kanji:日"'}},{origin});
 assert.equal(f.upstreamCalls.at(-1).msg.params.query,'"kanji:日"');
});
test('valid preflight permits a non-duplicate note without dictionary access',async t=>{
  const f=await fixture();t.after(f.cleanup);
  assert.deepEqual(await post(f.proxyUrl,{action:'canAddNotes',version:6,params:{notes:[note()]}},{origin}),{result:[true],error:null});
  assert.equal(f.upstreamCalls.some(x=>x.msg.action==='addNote'),false);
  assert.equal(f.upstreamCalls.some(x=>x.msg.action.startsWith('canAdd')),false);
});
test('preflight and addNote give safe actionable validation errors without creating notes',async t=>{
  const f=await fixture();t.after(f.cleanup);
  const cases=[
    ['invalid note',null,'Note must be an object'],
     ['model mismatch',{...note(),modelName:null},'Select the configured KanjiDamage model in Yomitan'],
    ['invalid fields',{...note(),fields:[]},'Note fields must be an object'],
    ['missing Kanji mapping',{...note(),fields:{Meaning:'meaning'}},'Map the Kanji field to {character} in Yomitan’s kanji-card settings'],
    ['non-string known field',{...note(),fields:{...note().fields,Meaning:4}},'Field “Meaning” must be a string'],
    ['non-string unknown field',{...note(),fields:{...note().fields,private:4}},'A note field must be a string'],
    ['blank Kanji',{...note(),fields:{...note().fields,Kanji:''}},'Map the Kanji field to {character} in Yomitan’s kanji-card settings; it must not be blank'],
    ['whitespace Kanji',{...note(),fields:{...note().fields,Kanji:'  '}},'Map the Kanji field to {character} in Yomitan’s kanji-card settings; it must not be blank'],
    ['HTML Kanji',{...note(),fields:{...note().fields,Kanji:'<b>鬱</b>'}},'Kanji must be exactly one Han ideograph (received 8 characters)'],
    ['multiple Kanji',{...note(),fields:{...note().fields,Kanji:'鬱鬱'}},'Kanji must be exactly one Han ideograph (received 2 characters)'],
    ['non-Han',{...note(),fields:{...note().fields,Kanji:'A'}},'Kanji must be exactly one Han ideograph (received 1 character)'],
  ];
  for(const [label,invalid,expected] of cases){
    const preflight=await post(f.proxyUrl,{action:'canAddNotesWithErrorDetail',version:6,params:{notes:[invalid]}},{origin});
    assert.deepEqual(preflight.result,[{canAdd:false,error:expected}],label);
    const added=await post(f.proxyUrl,{action:'addNote',version:6,params:{note:invalid}},{origin});
    assert.deepEqual(added,{result:null,error:expected},label);
  }
  for(const kanji of ['鬱','𠮷']){
    const valid=await post(f.proxyUrl,{action:'canAddNotesWithErrorDetail',version:6,params:{notes:[note(kanji)]}},{origin});
    assert.deepEqual(valid.result,[{canAdd:true,error:null}]);
  }
  assert.equal(f.created.length,0);
  assert.equal(f.upstreamCalls.some(x=>x.msg.action==='addNote'),false);
});
test('loopback command-line requests without Origin remain supported',async t=>{
 const f=await fixture();t.after(f.cleanup);
 const result=await post(f.proxyUrl,{action:'version',version:6});
 assert.deepEqual(result,{result:6,error:null});assert.equal(f.upstreamCalls[0].origin,undefined);
});
test('duplicate and enrichment failures never call addNote',async t=>{
 for(const opts of [{duplicate:true},{failEnrichment:true}]){const f=await fixture(opts);try{await post(f.proxyUrl,{action:'addNote',version:6,params:{note:note()}},{origin});assert.equal(f.created.length,0);}finally{await f.cleanup();}}
});
test('invalid upstream duplicate results fail closed without creation',async t=>{
 const f=await fixture({badFind:true});t.after(f.cleanup);
 const r=await post(f.proxyUrl,{action:'addNote',version:6,params:{note:note()}},{origin});
 assert.match(r.error,/invalid duplicate-check result/);assert.equal(f.created.length,0);
});
test('same-kanji concurrent adds serialize and second request sees duplicate',async t=>{
 const f=await fixture();t.after(f.cleanup);
 const req={action:'addNote',version:6,params:{note:note()}};
 const [a,b]=await Promise.all([post(f.proxyUrl,req,{origin}),post(f.proxyUrl,req,{origin})]);
 assert.equal(f.created.length,1);assert.equal([a,b].filter(x=>x.result===101).length,1);assert.equal([a,b].filter(x=>x.error?.includes('already exists')).length,1);
});
test('origin, host, batch, malformed fields and unsupported mutations are rejected',async t=>{
 const f=await fixture();t.after(f.cleanup);
 assert.equal((await fetch(f.proxyUrl,{method:'OPTIONS',headers:{origin:'https://evil.example'}})).status,403);
 assert.equal((await fetch(f.proxyUrl,{method:'OPTIONS',headers:{origin}})).status,204);
 assert.equal(await requestWithHost(f.proxyUrl,'evil.example'),403);
 assert.match((await post(f.proxyUrl,{action:'multi',version:6},{origin})).error,/multi requires/);
 assert.match((await post(f.proxyUrl,{action:'deleteNotes',version:6},{origin})).error,/not exposed/);
  assert.match((await post(f.proxyUrl,{action:'addNote',version:6,params:{note:{...note(),fields:{Kanji:{value:'日'}}}}},{origin})).error,/Field “Kanji” must be a string/);
 assert.equal(f.created.length,0);
});
