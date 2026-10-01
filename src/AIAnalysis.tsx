import { useEffect,useRef,useState } from 'react';
import { AlertCircle,CheckCircle2,RefreshCw,Sparkles } from 'lucide-react';
import { supabase } from './client';
import { rpc } from './data';
import { classStudents,responseFor,stats,type Dataset } from './domain';
import type { AIRun } from '../supabase/functions/_shared/analysis';

const issue=(e:unknown)=>e instanceof Error?e.message:typeof e==='object'&&e&&'message' in e?String(e.message):'Não foi possível carregar a análise.';
const date=(s:string)=>new Intl.DateTimeFormat('pt-BR',{dateStyle:'short',timeStyle:'short',timeZone:'America/Sao_Paulo'}).format(new Date(s));
export default function AIAnalysis({data,onReview}:{data:Dataset;onReview:(submissionId:string,studentId:string,classId:string)=>void}){
  const [id,setId]=useState(data.classes[0]?.id||''),[run,setRun]=useState<AIRun|null>(null),[busy,setBusy]=useState(false),[loading,setLoading]=useState(false),[error,setError]=useState('');
  const version=useRef(0);const classroom=data.classes.find(c=>c.id===id);const survey=data.surveys.find(s=>s.class_id===id&&s.code==='F4');
  useEffect(()=>{
    const current=++version.current;setRun(null);setError('');if(!id)return;setLoading(true);
    void rpc('latest_ai_analysis',{p_class_id:id}).then(result=>{if(version.current===current)setRun(result as AIRun|null);}).catch(e=>{if(version.current===current)setError(issue(e));}).finally(()=>{if(version.current===current)setLoading(false);});
    return()=>{version.current++;};
  },[id,data]);
  async function analyze(){
    if(!supabase||!id)return;setBusy(true);setError('');const current=version.current;
    try{
      const {data:result,error}=await supabase.functions.invoke('analyze-form4',{body:{class_id:id}});
      if(error){let message=error.message;if('context' in error&&error.context instanceof Response){try{message=(await error.context.clone().json()).error||message;}catch{/* Preserve the original error. */}}throw new Error(message);}
      if(!result?.analysis)throw new Error('Análise sem resultado.');
      if(current===version.current)setRun(result.analysis as AIRun);
    }catch(e){if(current===version.current)setError(issue(e));}
    finally{setBusy(false);}
  }
  const st=classroom?stats(data,classroom,survey):null;
  const pending=classStudents(data,id).filter(s=>!s.enrollment.excluded&&s.enrollment.attendance_verified&&(!survey||!responseFor(data,survey.id,s.id)));
  const report=run?.status==='completed'?run.result:null;
  return <>
    <div className="page-heading"><h1>Análise IA</h1><button className="button primary" disabled={!id||busy||loading||!pending.length} onClick={()=>void analyze()}>{busy?<RefreshCw size={17} className="spin"/>:<Sparkles size={17}/>} {busy?'Analisando…':'Analisar'}</button></div>
    <label className="survey-selector">Turma<select disabled={busy} value={id} onChange={e=>setId(e.target.value)}>{data.classes.map(c=><option key={c.id} value={c.id}>{c.code} · {c.name}</option>)}</select></label>
    {error&&<div className="alert error" role="alert"><AlertCircle size={17}/>{error}</div>}
    {st&&<div className="ai-numbers"><span><strong>{st.total}</strong> participantes</span><span><strong>{st.answered}</strong> responderam</span><span><strong>{st.pending}</strong> sem resposta vinculada</span></div>}
    {!id?<div className="empty">Importe o quadro de gestão.</div>:<>
      {loading&&<p className="muted small">Carregando…</p>}
      {run?.status==='running'&&<div className="alert">Uma análise está em andamento. Atualize em instantes.</div>}
      {run?.status==='failed'&&<div className="alert">{run.error||'Análise interrompida. Execute novamente.'}</div>}
      {report&&<section className="panel ai-report">
        <div className="ai-report-meta"><span>{date(run!.created_at)} · {run!.model}</span><span className={`status ${run!.is_current?'answered':'pending'}`}>{run!.is_current?'Atual':'Dados alterados'}</span></div>
        <p className="ai-summary">{report.advice.summary}</p>
        {!run!.is_current&&<p className="muted small">Execute novamente para conferir vínculos com os dados atuais.</p>}
        {report.advice.matches.length>0&&<><h2>Possíveis respostas</h2><div className="ai-suggestions">{report.advice.matches.map(m=>{
          const student=data.students.find(s=>s.id===m.student_id),submission=data.submissions.find(s=>s.id===m.submission_id);
          return <article key={m.student_id+m.submission_id}><div><strong>{student?.urn||'Matrícula'} · {student?.name||'Registro atualizado'}</strong><p>{m.reason}</p><small>{submission?.source_urn||'Sem matrícula'} · {submission?.source_name||'Sem nome'} · {m.confidence==='probable'?'Provável':'Possível'}</small></div><button className="button secondary" disabled={!run!.is_current||!submission||submission.state!=='review'||!student} onClick={()=>onReview(m.submission_id,m.student_id,id)}>Conferir</button></article>;
        })}</div></>}
        {report.advice.findings.length>0&&<><h2>Atenção</h2><div className="ai-findings">{report.advice.findings.map((f,i)=><article key={i}><AlertCircle size={17}/><div><strong>{f.student_id?data.students.find(s=>s.id===f.student_id)?.urn||'Registro atualizado':'Turma'}</strong><p>{f.detail}</p><small>{f.action}</small></div></article>)}</div></>}
        <small className="muted">Sugestões da IA exigem conferência. Os totais vêm dos vínculos registrados.</small>
      </section>}
      <section className="student-panel ai-pending"><div className="ai-table-heading"><h2>Sem resposta vinculada</h2><span>{pending.length}</span></div>{pending.length?<div className="table-scroll"><table><thead><tr><th>URN</th><th>Nome</th><th>Conferência</th></tr></thead><tbody>{pending.map(s=>{
        const suggested=!!run?.is_current&&report?.advice.matches.some(m=>m.student_id===s.id);
        return <tr key={s.id}><td><span className="urn">{s.urn.startsWith('SEM-')?'Sem matrícula':s.urn}</span></td><td>{s.name}</td><td>{s.enrollment.review_pending||suggested?<span className="status pending">Conferir resposta</span>:<span className="status neutral">Sem vínculo</span>}</td></tr>;
      })}</tbody></table></div>:<div className="empty"><CheckCircle2 size={25}/>{st?.total?'Todos os participantes têm resposta vinculada.':'Confirme a lista de presença.'}</div>}</section>
    </>}
  </>;
}
