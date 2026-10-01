import { adviceSchema,analysisInstructions,buildReport,extractAdviceResponse,type AISnapshot } from './analysis.ts';
type RpcResult={data:unknown;error:{message:string}|null};
export type Caller={id:string;admin:boolean;rpc:(name:string,args:Record<string,unknown>)=>PromiseLike<RpcResult>};
export type AnalysisDependencies={authenticate:(request:Request)=>Promise<Caller|null>;apiKey:()=>string;model:()=>string;origins:()=>string[];fetch:typeof fetch};
export function createAnalysisHandler(deps:AnalysisDependencies){
  return async(request:Request):Promise<Response>=>{
    const origin=request.headers.get('origin');const allowed=!origin||deps.origins().includes(origin);
    const headers:Record<string,string>={'Content-Type':'application/json','Cache-Control':'no-store','Vary':'Origin'};
    if(origin&&allowed)headers['Access-Control-Allow-Origin']=origin;
    headers['Access-Control-Allow-Headers']='authorization,apikey,content-type,x-client-info,x-supabase-api-version';
    headers['Access-Control-Allow-Methods']='POST,OPTIONS';
    const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers});
    if(!allowed)return json({error:'Origem não autorizada.'},403);
    if(request.method==='OPTIONS')return new Response(null,{status:204,headers});
    if(request.method!=='POST')return json({error:'Use POST.'},405);
    let caller:Caller|null=null,runId='',model='';
    try{
      caller=await deps.authenticate(request);
      if(!caller)return json({error:'Entre novamente para analisar.'},401);
      if(!caller.admin)return json({error:'Acesso administrativo necessário.'},403);
      const raw=await request.text();if(raw.length>2048)return json({error:'Requisição acima do limite.'},413);
      let body;try{body=JSON.parse(raw);}catch{return json({error:'Requisição inválida.'},400);}
      if(!body||typeof body.class_id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.class_id))return json({error:'Selecione uma turma válida.'},400);
      const apiKey=deps.apiKey();if(!apiKey)return json({error:'Configure OPENAI_API_KEY em Supabase → Edge Functions → Secrets.'},503);
      model=deps.model()||'gpt-4.1-mini';
      const begun=await caller.rpc('begin_ai_analysis',{p_class_id:body.class_id});
      if(begun.error)return json({error:begun.error.message},409);
      const reservation=begun.data as {run_id:string;snapshot:AISnapshot};runId=reservation.run_id;
      const snapshot=reservation.snapshot;
      const inventory=buildReport(snapshot,{summary:'',matches:[],findings:[]}).totals;
      const timer=AbortSignal.timeout(65000);
      const response=await deps.fetch('https://api.openai.com/v1/responses',{
        method:'POST',headers:{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json'},signal:timer,
        body:JSON.stringify({model,store:false,instructions:analysisInstructions,input:JSON.stringify({inventory,data:snapshot}),max_output_tokens:6000,text:{format:{type:'json_schema',name:'sidp_form4_review',strict:true,schema:adviceSchema}}})
      });
      if(!response.ok){
        const message=response.status===401?'A chave OpenAI não foi aceita. Confira o secret OPENAI_API_KEY.':response.status===429?'Limite ou saldo da API OpenAI indisponível. Confira sua conta.':response.status===400?'Configuração da OpenAI não aceita. Confira OPENAI_MODEL e os logs da função.':'A OpenAI está indisponível. Tente novamente.';
        // Do not echo provider response bodies, secrets or source data into errors.
        throw new Error(message);
      }
      const advice=extractAdviceResponse(await response.json(),snapshot);
      const report=buildReport(snapshot,advice);
      const saved=await caller.rpc('finish_ai_analysis',{p_run_id:runId,p_result:report,p_model:model,p_error:''});
      if(saved.error)throw new Error('Não foi possível salvar a análise. Atualize antes de tentar novamente.');
      const latest=await caller.rpc('latest_ai_analysis',{p_class_id:body.class_id});
      if(latest.error)throw new Error('Análise salva. Atualize a página para consultá-la.');
      return json({analysis:latest.data});
    }catch(error){
      const known=error instanceof Error?error.message:'';
      const message=error instanceof DOMException&&['TimeoutError','AbortError'].includes(error.name)?'A análise excedeu o tempo disponível. Tente novamente.':known.startsWith('A IA')||known.startsWith('A OpenAI')||known.startsWith('A chave')||known.startsWith('Resultado da IA')||known.startsWith('Limite ou saldo')||known.startsWith('Configuração da OpenAI')||known.startsWith('Não foi possível salvar')||known.startsWith('Análise salva')?known:'Não foi possível concluir a análise. Confira a conexão e os logs da função.';
      if(caller&&runId){try{await caller.rpc('finish_ai_analysis',{p_run_id:runId,p_result:null,p_model:model,p_error:message});}catch{/* A later attempt marks interrupted reservations as failed. */}}
      return json({error:message},502);
    }
  };
}
