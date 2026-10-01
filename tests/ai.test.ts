import test from 'node:test';
import assert from 'node:assert/strict';
import {buildReport,validateAdvice,extractAdviceResponse,type AISnapshot,type AIAdvice} from '../supabase/functions/_shared/analysis.ts';
import {createAnalysisHandler,type Caller} from '../supabase/functions/_shared/handler.ts';
import {renderMessage} from '../src/domain.ts';

const cid='00000000-0000-0000-0000-000000000001';
const snapshot=():AISnapshot=>({as_of:'2026-10-01',class:{id:cid,code:'T01',name:'Centro',starts_on:'2026-08-03',ends_on:'2026-08-07',followup_on:'2026-08-28'},classes:[],imports:[],
  participants:[
    {student_id:'pending',urn:'L-B10001',name:'Ana Maria Silva',excluded:false,verified:true,review_pending:false,flags:[],responded_at:null},
    {student_id:'answered',urn:'L-B10002',name:'Beatriz Santos',excluded:false,verified:true,review_pending:false,flags:[],responded_at:'2026-09-01T12:00:00Z'},
    {student_id:'excluded',urn:'L-B10003',name:'Carlos Lima',excluded:true,verified:true,review_pending:false,flags:[],responded_at:null},
    {student_id:'unverified',urn:'L-B10004',name:'Dora Melo',excluded:false,verified:false,review_pending:false,flags:[],responded_at:null}],
  submissions:[{id:'review',urn:'L-B10001',name:'Ana Silva',submitted_at:'2026-08-29T12:00:00Z',state:'review',student_id:null,class_id:null,flags:[],match_origin:'automatic'},
    {id:'linked',urn:'L-B10002',name:'Beatriz Santos',submitted_at:'2026-09-01T12:00:00Z',state:'linked',student_id:'answered',class_id:cid,flags:[],match_origin:'manual'}]});
const advice=():AIAdvice=>({summary:'Um registro exige conferência.',matches:[{student_id:'pending',submission_id:'review',confidence:'probable',reason:'Mesmo URN; nome do meio abreviado.'}],findings:[]});

test('AI cannot change official totals, attendance or completion; suggestions block reminders',()=>{
  const report=buildReport(snapshot(),advice());assert.deepEqual(report.totals,{eligible:2,responded:1,pending:1,in_review:1,reminders:0,excluded:1,unverified:1});
  assert.equal(report.pending[0].status,'review');assert.equal(report.pending[0].can_remind,false);
  const s=snapshot();s.as_of='2026-08-20';assert.equal(buildReport(s,{summary:'',matches:[],findings:[]}).totals.reminders,0);
  s.as_of='2026-10-01';assert.equal(buildReport(s,{summary:'',matches:[],findings:[]}).totals.reminders,1);
});
test('unknown, answered, excluded, unverified and already-linked AI matches are rejected',()=>{
  for(const student_id of ['unknown','answered','excluded','unverified'])assert.throws(()=>validateAdvice({...advice(),matches:[{...advice().matches[0],student_id}]},snapshot()));
  assert.throws(()=>validateAdvice({...advice(),matches:[{...advice().matches[0],submission_id:'linked'}]},snapshot()));
  assert.throws(()=>validateAdvice({...advice(),matches:[advice().matches[0],advice().matches[0]]},snapshot()));
  assert.throws(()=>validateAdvice({...advice(),findings:[{kind:'identity',student_id:'invented',submission_id:null,detail:'x',action:'x'}]},snapshot()));
  const s=snapshot();s.submissions[0].submitted_at=null;assert.throws(()=>validateAdvice(advice(),s));
});
test('refused, incomplete and malformed provider responses never become an analysis',()=>{
  assert.throws(()=>extractAdviceResponse({status:'incomplete',output:[]},snapshot()));
  assert.throws(()=>extractAdviceResponse({status:'completed',output:[{type:'message',content:[{type:'refusal',refusal:'No'}]}]},snapshot()));
  assert.throws(()=>extractAdviceResponse({status:'completed',output:[{type:'message',content:[{type:'output_text',text:'broken json'}]}]},snapshot()));
});
test('partner message substitutes both name placeholders with URN',()=>{
  const student={id:'s',urn:'L-B10001',name:'Ana Maria Silva',phone:'5591999990000'};
  const classroom={id:cid,code:'T01',name:'Centro',partner:'',starts_on:'',ends_on:'',followup_on:'',shift:'',management_imported:true};
  const survey={id:'f4',class_id:cid,code:'F4',name:'Form 4',url:'https://example.org/f4',due_date:null,message_template:'Olá {nome}, {nome_completo}. URN {matricula}.'};
  assert.equal(renderMessage(survey.message_template,student,classroom,survey,true),'Olá L-B10001, L-B10001. URN L-B10001.');
  assert.match(renderMessage(survey.message_template,student,classroom,survey),/Ana Maria Silva/);
});

function harness(options:{admin?:boolean;authenticated?:boolean;key?:string;providerStatus?:number;invalid?:boolean;reservationError?:string}={}){
  const calls:{name:string;args:Record<string,unknown>}[]=[];const requests:RequestInit[]=[];let keyReads=0;
  const caller:Caller={id:'admin',admin:options.admin??true,rpc:async(name,args)=>{
    calls.push({name,args});if(name==='begin_ai_analysis')return options.reservationError?{data:null,error:{message:options.reservationError}}:{data:{run_id:'run',snapshot:snapshot()},error:null};
    if(name==='latest_ai_analysis')return {data:{id:'run',status:'completed',result:buildReport(snapshot(),advice()),is_current:true},error:null};
    return {data:null,error:null};
  }};
  const handle=createAnalysisHandler({authenticate:async()=>options.authenticated===false?null:caller,apiKey:()=>{keyReads++;return options.key??'sk-test-placeholder';},model:()=>'',origins:()=>['https://moraisdsantos.github.io'],fetch:(async(_url,init)=>{
    requests.push(init!);if(options.providerStatus)return new Response('DO NOT ECHO sk-test-placeholder',{status:options.providerStatus});
    const output=options.invalid?{...advice(),matches:[{...advice().matches[0],student_id:'invented'}]}:advice();
    return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(output)}]}]});
  }) as typeof fetch});
  const request=(body:unknown={class_id:cid},origin='https://moraisdsantos.github.io')=>new Request('https://example.org/functions/v1/analyze-form4',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify(body)});
  return {handle,request,calls,requests,get keyReads(){return keyReads;}};
}
test('AI endpoint authenticates and requires admin before touching a key, data or provider',async()=>{
  for(const options of [{authenticated:false},{admin:false}]){const h=harness(options);const res=await h.handle(h.request());assert.equal(res.status,options.authenticated===false?401:403);assert.equal(h.keyReads,0);assert.equal(h.calls.length,0);assert.equal(h.requests.length,0);}
  const h=harness();assert.equal((await h.handle(h.request({},'https://untrusted.example'))).status,403);assert.equal(h.keyReads,0);
  const preflight=await h.handle(new Request('https://example.org',{method:'OPTIONS',headers:{origin:'https://moraisdsantos.github.io'}}));assert.equal(preflight.status,204);
});
test('missing secret, invalid class and database limits do not call OpenAI',async()=>{
  const noKey=harness({key:''});assert.equal((await noKey.handle(noKey.request())).status,503);assert.equal(noKey.requests.length,0);
  const invalid=harness();assert.equal((await invalid.handle(invalid.request({class_id:'not-a-uuid'}))).status,400);assert.equal(invalid.keyReads,0);
  const limited=harness({reservationError:'Limite de análises atingido.'});assert.equal((await limited.handle(limited.request())).status,409);assert.equal(limited.requests.length,0);
});
test('endpoint uses database snapshot, strict schema and server key, then saves advice only',async()=>{
  const h=harness();const res=await h.handle(h.request({class_id:cid,snapshot:{participants:['injected']}}));assert.equal(res.status,200);assert.equal(res.headers.get('Access-Control-Allow-Origin'),'https://moraisdsantos.github.io');
  const body=JSON.parse(h.requests[0].body as string);assert.equal(body.store,false);assert.equal(body.model,'gpt-4.1-mini');assert.equal(body.text.format.strict,true);assert.equal(JSON.parse(body.input).data.participants[0].name,'Ana Maria Silva');assert.ok(!body.input.includes('injected'));
  assert.deepEqual(h.calls.map(c=>c.name),['begin_ai_analysis','finish_ai_analysis','latest_ai_analysis']);assert.equal((h.calls[1].args.p_result as any).totals.responded,1);
});
test('provider failure and hallucinated IDs save failure without revealing key or counting responses',async()=>{
  for(const options of [{providerStatus:401},{invalid:true}]){const h=harness(options);const res=await h.handle(h.request());assert.equal(res.status,502);assert.ok(!(await res.text()).includes('sk-test-placeholder'));assert.deepEqual(h.calls.map(c=>c.name),['begin_ai_analysis','finish_ai_analysis']);assert.equal(h.calls[1].args.p_result,null);}
});
