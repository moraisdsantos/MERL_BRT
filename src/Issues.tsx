import { useState } from 'react';
import { AlertTriangle,Check,CheckCircle2,Pencil,Plus,RotateCcw,Search } from 'lucide-react';
import Dialog from './Dialog';
import { ISSUE_CATEGORIES,type Dataset,type Issue } from './domain';

const categoryLabel=(c:Issue['category'])=>ISSUE_CATEGORIES.find(([id])=>id===c)?.[1]||c;
const date=(value?:string|null)=>value?new Intl.DateTimeFormat('pt-BR',{day:'2-digit',month:'2-digit',year:'numeric',timeZone:'America/Sao_Paulo'}).format(new Date(value)):'—';
const errorText=(e:unknown)=>e instanceof Error?e.message:'Não foi possível salvar.';
type Draft={id:string|null;category:Issue['category'];title:string;detail:string;recommendation:string;class_ids:string[]};
const emptyDraft=():Draft=>({id:null,category:'formulario',title:'',detail:'',recommendation:'',class_ids:[]});

export default function Issues({data,admin,busy,onSave,onStatus}:{data:Dataset;admin:boolean;busy:boolean;
  onSave:(id:string|null,category:string,title:string,detail:string,recommendation:string,classIds:string[])=>Promise<void>;
  onStatus:(id:string,status:'aberta'|'resolvida',note:string)=>Promise<void>}){
  const [filter,setFilter]=useState<'aberta'|'resolvida'|'todas'>('aberta');
  const [category,setCategory]=useState('todas');
  const [query,setQuery]=useState('');
  const [draft,setDraft]=useState<Draft|null>(null);
  const [resolving,setResolving]=useState<Issue|null>(null);
  const classCode=(id:string)=>data.classes.find(c=>c.id===id)?.code||'—';
  const visible=[...data.issues]
    .filter(i=>(filter==='todas'||i.status===filter)&&(category==='todas'||i.category===category)&&`${i.title} ${i.detail} ${i.recommendation}`.toLowerCase().includes(query.toLowerCase()))
    .sort((a,b)=>Number(a.status==='resolvida')-Number(b.status==='resolvida')||b.created_at.localeCompare(a.created_at));
  const open=data.issues.filter(i=>i.status==='aberta').length;
  return <>
    <div className="page-heading"><div><h1>Problemas</h1><p>{open?`${open} em aberto`:'Nada em aberto'} · registro de campo compartilhado com as implementadoras das turmas citadas</p></div>
      {admin&&<button className="button primary" onClick={()=>setDraft(emptyDraft())}><Plus size={17}/>Registrar problema</button>}</div>
    <section className="student-panel">
      <div className="list-toolbar">
        <div className="tabs">{([['aberta','Em aberto'],['resolvida','Resolvidos'],['todas','Todos']] as const).map(([id,label])=><button key={id} className={filter===id?'selected':''} onClick={()=>setFilter(id)}>{label}</button>)}
        <select aria-label="Categoria" className="inline-select" value={category} onChange={e=>setCategory(e.target.value)}><option value="todas">Todas as categorias</option>{ISSUE_CATEGORIES.map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></div>
        <label className="search"><Search size={16}/><input aria-label="Buscar problema" placeholder="Buscar" value={query} onChange={e=>setQuery(e.target.value)}/></label>
      </div>
      {visible.length?<ul className="issue-list">{visible.map(i=><li key={i.id} className={`issue ${i.status}`}>
        <div className="issue-main">
          <div className="issue-top">
            <span className={`issue-category cat-${i.category}`}>{categoryLabel(i.category)}</span>
            {i.class_ids.length?i.class_ids.map(id=><span className="issue-class" key={id}>{classCode(id)}</span>):<span className="issue-class geral">Geral</span>}
            <span className="issue-date">{date(i.created_at)}</span>
          </div>
          <h3>{i.title}</h3>
          {i.detail&&<p>{i.detail}</p>}
          {i.recommendation&&<p className="issue-recommendation"><strong>Encaminhamento:</strong> {i.recommendation}</p>}
          {i.status==='resolvida'&&<p className="issue-resolution"><CheckCircle2 size={14}/>Resolvido em {date(i.resolved_at)}{i.resolution_note?` · ${i.resolution_note}`:''}</p>}
        </div>
        {admin&&<div className="issue-actions">
          {i.status==='aberta'?<button className="button secondary" disabled={busy} onClick={()=>setResolving(i)}><Check size={15}/>Resolver</button>
            :<button className="button secondary" disabled={busy} onClick={()=>void onStatus(i.id,'aberta','')}><RotateCcw size={15}/>Reabrir</button>}
          <button className="icon-button" aria-label={`Editar ${i.title}`} onClick={()=>setDraft({id:i.id,category:i.category,title:i.title,detail:i.detail,recommendation:i.recommendation,class_ids:i.class_ids})}><Pencil size={16}/></button>
        </div>}
      </li>)}</ul>:<div className="empty"><AlertTriangle size={25}/><p>{data.issues.length?'Nenhum problema neste filtro.':admin?'Nenhum problema registrado até aqui.':'Nenhum problema registrado para as suas turmas.'}</p></div>}
    </section>
    {draft&&<IssueDialog draft={draft} data={data} busy={busy} onClose={()=>setDraft(null)} onSave={async d=>{await onSave(d.id,d.category,d.title,d.detail,d.recommendation,d.class_ids);setDraft(null);}}/>}
    {resolving&&<ResolveIssueDialog issue={resolving} busy={busy} onClose={()=>setResolving(null)} onResolve={async note=>{await onStatus(resolving.id,'resolvida',note);setResolving(null);}}/>}
  </>;
}
function IssueDialog({draft,data,busy,onClose,onSave}:{draft:Draft;data:Dataset;busy:boolean;onClose:()=>void;onSave:(d:Draft)=>Promise<void>}){
  const [d,setD]=useState(draft);const [error,setError]=useState('');
  return <Dialog title={d.id?'Editar problema':'Registrar problema'} onClose={()=>{if(!busy)onClose();}}>
    {error&&<div className="alert error" role="alert">{error}</div>}
    <form onSubmit={async e=>{e.preventDefault();setError('');try{await onSave(d);}catch(err){setError(errorText(err));}}}>
      <label>Categoria<select value={d.category} onChange={e=>setD({...d,category:e.target.value as Issue['category']})}>{ISSUE_CATEGORIES.map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></label>
      <label>Título<input required value={d.title} onChange={e=>setD({...d,title:e.target.value})} placeholder="O que aconteceu, em uma linha"/></label>
      <label>Detalhe<textarea rows={3} value={d.detail} onChange={e=>setD({...d,detail:e.target.value})} placeholder="Contexto: quem, quando, qual arquivo"/></label>
      <label>Encaminhamento<textarea rows={2} value={d.recommendation} onChange={e=>setD({...d,recommendation:e.target.value})} placeholder="O que precisa acontecer para resolver"/></label>
      <fieldset className="class-checks"><legend>Turmas afetadas (vazio = geral)</legend>
        {data.classes.map(c=><label className="checkbox-label" key={c.id}><input type="checkbox" checked={d.class_ids.includes(c.id)} onChange={e=>setD({...d,class_ids:e.target.checked?[...d.class_ids,c.id]:d.class_ids.filter(x=>x!==c.id)})}/><span>{c.code} · {c.name}</span></label>)}
      </fieldset>
      <div className="dialog-actions"><button type="button" className="button secondary" disabled={busy} onClick={onClose}>Cancelar</button><button className="button primary" disabled={busy||!d.title.trim()}>Salvar<Check size={16}/></button></div>
    </form>
  </Dialog>;
}
function ResolveIssueDialog({issue,busy,onClose,onResolve}:{issue:Issue;busy:boolean;onClose:()=>void;onResolve:(note:string)=>Promise<void>}){
  const [note,setNote]=useState('');const [error,setError]=useState('');
  return <Dialog title="Resolver problema" onClose={()=>{if(!busy)onClose();}}>
    {error&&<div className="alert error" role="alert">{error}</div>}
    <p className="muted small">{issue.title}</p>
    <form onSubmit={async e=>{e.preventDefault();setError('');try{await onResolve(note);}catch(err){setError(errorText(err));}}}>
      <label>Como foi resolvido<input required value={note} onChange={e=>setNote(e.target.value)} placeholder="Registro curto para a trilha do MERL"/></label>
      <div className="dialog-actions"><button type="button" className="button secondary" disabled={busy} onClick={onClose}>Cancelar</button><button className="button primary" disabled={busy||!note.trim()}>Resolver<Check size={16}/></button></div>
    </form>
  </Dialog>;
}
