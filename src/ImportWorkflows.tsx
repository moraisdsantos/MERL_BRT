import { useEffect,useRef,useState } from 'react';
import { Check,FileSpreadsheet,FileText,Plus,Upload,X } from 'lucide-react';
import Dialog from './Dialog';
import { parseManagement,type ManagedClass } from './management';
import { readDataset } from './import-file';
import { compactURN,normalizeName,prepareForm4 } from './matching';
import type { AttendanceRow } from './attendance-layout';
import type { AttendanceResult } from './attendance-pdf';
import type { Dataset,Form4Submission } from './domain';
export type WorkflowKind='management'|'attendance'|'form4';
export type WorkflowPayload={rows:unknown[];source?:Record<string,unknown>[];classId?:string};
const message=(e:unknown)=>e instanceof Error?e.message:'Não foi possível ler o arquivo.';
export default function ImportWorkflows({kind,data,classId:initialClass,onClose,onSave}:{kind:WorkflowKind;data:Dataset;classId?:string;onClose:()=>void;onSave:(kind:WorkflowKind,payload:WorkflowPayload,filename:string)=>Promise<void>}){
  const [filename,setFilename]=useState(''),[progress,setProgress]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const [board,setBoard]=useState<ManagedClass[]>([]),[boardErrors,setBoardErrors]=useState<string[]>([]);
  const [classId,setClassId]=useState(initialClass||data.classes[0]?.id||'');
  const [attendance,setAttendance]=useState<AttendanceResult|null>(null),[confirmed,setConfirmed]=useState(false),[page,setPage]=useState(0);
  const [form4,setForm4]=useState<Awaited<ReturnType<typeof prepareForm4>>|null>(null),[source,setSource]=useState<Record<string,unknown>[]>([]);
  const pagesRef=useRef<string[]>([]),mounted=useRef(true);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;pagesRef.current.forEach(URL.revokeObjectURL);};},[]);
  const title=kind==='management'?'Quadro de gestão':kind==='attendance'?'Lista de presença':'Respostas · Form 4';
  const selected=attendance?.rows.filter(r=>r.include)||[];
  const duplicate=selected.some((r,i)=>selected.some((s,j)=>j!==i&&r.urn&&compactURN(r.urn)===compactURN(s.urn)));
  const invalid=selected.some(r=>!r.name.trim()||r.urn.includes(' '));
  const canSave=kind==='management'?board.length>0&&!boardErrors.length:kind==='attendance'?!!classId&&selected.length>0&&confirmed&&!duplicate&&!invalid:!!form4;
  async function load(file:File){
    setBusy(true);setError('');setFilename('');setBoard([]);setBoardErrors([]);setForm4(null);setSource([]);setConfirmed(false);setAttendance(null);pagesRef.current.forEach(URL.revokeObjectURL);pagesRef.current=[];
    try{
      if(kind==='management'){if(file.size>10*1024*1024)throw new Error('CSV limitado a 10 MB.');if(!/\.csv$/i.test(file.name))throw new Error('Selecione um CSV.');const result=parseManagement(await file.text());if(mounted.current){setBoard(result.rows);setBoardErrors(result.errors);}}
      if(kind==='attendance'){const {readAttendancePDF}=await import('./attendance-pdf');const result=await readAttendancePDF(file,text=>{if(mounted.current)setProgress(text);});if(!mounted.current){result.pages.forEach(URL.revokeObjectURL);return;}pagesRef.current=result.pages;setAttendance(result);setPage(0);}
      if(kind==='form4'){const records=await readDataset(file);if(!records.length)throw new Error('Arquivo sem registros.');const result=await prepareForm4(records,data);if(mounted.current){setForm4(result);setSource(records);}}
      if(mounted.current)setFilename(file.name);
    }catch(e){if(mounted.current)setError(message(e));}finally{if(mounted.current){setBusy(false);setProgress('');}}
  }
  function updateRow(key:string,patch:Partial<AttendanceRow>){setConfirmed(false);setAttendance(a=>a?{...a,rows:a.rows.map(r=>r.key===key?{...r,...patch}:r)}:a);}
  async function save(){
    setBusy(true);setError('');
    try{
      let payload:WorkflowPayload={rows:board};
      if(kind==='attendance'){
        const rows=await Promise.all(selected.map(async row=>{
          const attention=row.attention.filter(x=>!['Nome incompleto','Nome não identificado','Matrícula repetida'].includes(x));
          let urn=row.urn.trim().toUpperCase();if(!urn){const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(classId+'|'+normalizeName(row.name)));urn='SEM-'+Array.from(new Uint8Array(hash)).slice(0,10).map(x=>x.toString(16).padStart(2,'0')).join('');attention.push('Matrícula ausente');}
          return {...row,urn,name:row.name.trim(),phone:row.phone.trim(),attention,attendance_verified:true};
        }));payload={rows,classId};
      }
      if(kind==='form4')payload={rows:form4!.rows,source};
      await onSave(kind,payload,filename);onClose();
    }catch(e){setError(message(e));}finally{if(mounted.current)setBusy(false);}
  }
  return <Dialog title={title} onClose={()=>{if(!busy)onClose();}} wide>
    {error&&<div className="alert error" role="alert">{error}</div>}
    {kind==='attendance'&&<label>Turma<select disabled={busy} value={classId} onChange={e=>setClassId(e.target.value)}><option value="" disabled>Selecione</option>{data.classes.map(c=><option key={c.id} value={c.id}>{c.code} · {c.name}</option>)}</select></label>}
    <label className="file-drop">{kind==='attendance'?<FileText size={28}/>:<FileSpreadsheet size={28}/>}<strong>{busy?progress||'Processando…':filename||'Selecionar arquivo'}</strong><span>{kind==='attendance'?'PDF único, até 25 páginas':kind==='management'?'CSV':'CSV, TSV ou XLSX'}</span><input type="file" accept={kind==='attendance'?'.pdf':kind==='management'?'.csv':'.csv,.tsv,.xlsx'} disabled={busy} aria-label={`Selecionar ${title}`} onChange={e=>{const file=e.target.files?.[0];if(file)void load(file);}}/></label>
    {boardErrors.map(x=><div className="alert error" role="alert" key={x}>{x}</div>)}
    {board.length>0&&<div className="table-scroll preview-table"><table><thead><tr><th>Turma</th><th>Centro</th><th>Aulas</th><th>Form 4</th></tr></thead><tbody>{board.map(c=><tr key={c.code}><td>{c.code}</td><td>{c.name}</td><td>{c.starts_on.split('-').reverse().join('/')} – {c.ends_on.split('-').reverse().join('/')}</td><td>{c.followup_on.split('-').reverse().join('/')}</td></tr>)}</tbody></table></div>}
    {attendance&&<>
      {attendance.warnings.map(w=><div className="alert" key={w}>{w}</div>)}
      <div className="attendance-preview"><div className="preview-page-toolbar"><span>PDF · página {page+1}/{attendance.pages.length}</span><select aria-label="Página do PDF" value={page} onChange={e=>setPage(+e.target.value)}>{attendance.pages.map((_,i)=><option key={i} value={i}>Página {i+1}</option>)}</select></div><img src={attendance.pages[page]} alt={`Lista de presença, página ${page+1}`}/></div>
      <div className="section-heading"><h3>Participantes · {selected.length}</h3><button className="text-button" onClick={()=>{setConfirmed(false);setAttendance(a=>a?{...a,rows:[...a.rows,{key:crypto.randomUUID(),urn:'',name:'',phone:'',page:page+1,include:true,attention:['Cadastro manual'],source_text:''}]}:a);}}><Plus size={15}/>Adicionar</button></div>
      {duplicate&&<div className="alert error" role="alert">Matrículas repetidas. Corrija ou desmarque as linhas.</div>}
      <div className="table-scroll attendance-edit"><table><thead><tr><th>Participou</th><th>Nome</th><th>Matrícula</th><th>Telefone</th><th><span className="sr-only">Observações</span></th></tr></thead><tbody>{attendance.rows.map(row=><tr key={row.key}><td><input type="checkbox" aria-label={`${row.name||'Participante'} participou`} checked={row.include} onChange={e=>updateRow(row.key,{include:e.target.checked})}/></td><td><input aria-label="Nome" value={row.name} onChange={e=>updateRow(row.key,{name:e.target.value})}/></td><td><input aria-label="Matrícula" value={row.urn} onChange={e=>updateRow(row.key,{urn:e.target.value})}/></td><td><input aria-label="Telefone" value={row.phone} onChange={e=>updateRow(row.key,{phone:e.target.value})}/></td><td>{row.attention.length>0&&<span className="status pending" title={row.attention.join('; ')}>Conferir</span>}</td></tr>)}</tbody></table></div>
      <label className="checkbox-label attendance-confirm"><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/><span>Conferi os dados e a presença dos participantes selecionados.</span></label>
    </>}
    {form4&&<><div className="import-result"><span><b>{form4.rows.length}</b> Brasil</span><span><b>{form4.linked}</b> vínculos</span><span><b>{form4.review}</b> a revisar</span><span><b>{form4.other}</b> outros países</span></div>{form4.repeated>0&&<div className="alert">{form4.repeated} registros repetidos no arquivo.</div>}<div className="table-scroll preview-table"><table><thead><tr><th>Nome no Form 4</th><th>Turma</th><th>Conciliação</th></tr></thead><tbody>{form4.rows.slice(0,10).map((r:Omit<Form4Submission,'id'>)=><tr key={r.external_id}><td>{r.source_name||'—'}</td><td>{data.classes.find(c=>c.id===r.class_id)?.code||'—'}</td><td><span className={`status ${r.state==='linked'?'answered':'pending'}`}>{r.state==='linked'?'Vinculado':'Conferir'}</span>{r.flags.length>0&&<span className="inline-attention" title={r.flags.join('; ')}>Atenção</span>}</td></tr>)}</tbody></table></div></>}
    <div className="dialog-actions"><button className="button secondary" disabled={busy} onClick={onClose}>Cancelar</button><button className="button primary" disabled={busy||!canSave} onClick={()=>void save()}>{busy?'Salvando…':'Importar'}<Check size={16}/></button></div>
  </Dialog>;
}
