import { useEffect,useState } from 'react';
import { AlertCircle,Check,ExternalLink,MessageSquare,RefreshCw,Search } from 'lucide-react';
import { supabase } from './client';
import { FORM_CODES,classLabel,formApplies,formDue,formLabel,whatsappPhone,whatsappUrl,type ClassRow,type FormCode,type Survey } from './domain';
import { brazilToday } from './management';

// Painel público por turma: URN, status do preenchimento e botão de WhatsApp.
// O link (token) é a credencial; nomes das participantes nunca chegam aqui.
type BoardStudent={urn:string;phone:string;safeguarding?:boolean;responses:Record<string,string|null>;sent:Record<string,string|null>};
type BoardSurvey={code:FormCode;name:string;url:string;message_template:string;due_date:string|null};
type Board={class:{name:string;shift:string;level:string;starts_on:string|null;ends_on:string|null;followup_on:string|null};surveys:BoardSurvey[];students:BoardStudent[]};

const date=(value?:string|null)=>value?new Intl.DateTimeFormat('pt-BR',{day:'2-digit',month:'2-digit',year:'numeric',timeZone:'America/Sao_Paulo'}).format(new Date(value.length===10?value+'T15:00:00Z':value)):'—';
const dateTime=(value:string)=>{const f=(options:Intl.DateTimeFormatOptions)=>new Intl.DateTimeFormat('pt-BR',{...options,timeZone:'America/Sao_Paulo'}).format(new Date(value));return `${f({day:'2-digit',month:'2-digit',year:'numeric'})} às ${f({hour:'2-digit',minute:'2-digit'})}`;};
const errorText=(e:unknown)=>e instanceof Error?e.message:'Não foi possível carregar o painel.';

export default function ClassBoard({token}:{token:string}){
  const [board,setBoard]=useState<Board|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(true);
  const [formCode,setFormCode]=useState<FormCode>('F3'),[query,setQuery]=useState('');
  useEffect(()=>{void (async()=>{
    if(!supabase){setError('Conexão indisponível.');setLoading(false);return;}
    try{const {data,error}=await supabase.rpc('get_class_board',{p_token:token});if(error)throw error;
      const b=data as Board;setBoard(b);
      const c=pseudoClass(b);const first=FORM_CODES.find(code=>formApplies(c,code));if(first)setFormCode(first);
    }catch(e){setError(errorText(e));}finally{setLoading(false);}
  })();},[token]);
  if(loading)return <div className="loading"><RefreshCw size={24} className="spin"/></div>;
  if(error||!board)return <div className="loading"><AlertCircle size={24}/><p>{error||'Painel indisponível.'}</p></div>;
  const classroom=pseudoClass(board);
  const codes=FORM_CODES.filter(code=>formApplies(classroom,code)&&board.surveys.some(s=>s.code===code));
  const survey=board.surveys.find(s=>s.code===formCode);
  const due=formDue(classroom,formCode);const ready=!!due&&brazilToday()>=due;
  const visible=board.students.filter(s=>`${s.urn} ${s.phone}`.toLowerCase().includes(query.toLowerCase()));
  const answered=board.students.filter(s=>s.responses[formCode]).length;
  async function send(student:BoardStudent){
    try{const {data,error}=await supabase!.rpc('log_class_message',{p_token:token,p_urn:student.urn,p_code:formCode});if(error)throw error;
      setBoard(b=>b?{...b,students:b.students.map(s=>s.urn===student.urn?{...s,sent:{...s.sent,[formCode]:String(data)}}:s)}:b);
    }catch{/* o registro é melhor esforço; o WhatsApp já abriu */}
  }
  return <div className="board-shell">
    <header className="board-header">
      <div className="brand-v2"><img src={`${import.meta.env.BASE_URL}arca.png`} alt="arca"/><div><strong>SIDP</strong><small>Acompanhamento da turma</small></div></div>
      <h1>{classLabel(classroom)}</h1>
      <p className="muted">{date(classroom.starts_on)} – {date(classroom.ends_on)} · {classroom.level||'Básico'}</p>
      <div className="form-switch" role="group" aria-label="Formulário">{codes.map(code=><button key={code} className={formCode===code?'selected':''} onClick={()=>setFormCode(code)}>{formLabel(code)}</button>)}</div>
    </header>
    <div className="board-meta"><span>{answered}/{board.students.length} responderam</span><span>{ready?`Aplicação liberada desde ${date(due)}`:`Aplicação a partir de ${date(due)}`}</span></div>
    <section className="student-panel">
      <div className="list-toolbar"><label className="search"><Search size={16}/><input aria-label="Buscar por matrícula ou telefone" placeholder="Matrícula ou telefone" value={query} onChange={e=>setQuery(e.target.value)}/></label></div>
      {visible.length?<div className="table-scroll"><table><thead><tr><th>URN · WhatsApp</th><th>{formLabel(formCode)}</th><th>Mensagem</th></tr></thead><tbody>
        {visible.map(s=>{
          const responded=s.responses[formCode];const sent=s.sent[formCode];
          const url=ready&&survey&&!responded&&!s.safeguarding&&!s.urn.startsWith('SEM-')?whatsappUrl({id:'',name:'',urn:s.urn,phone:s.phone},classroom,pseudoSurvey(survey)):null;
          return <tr key={s.urn}>
            <td><span className="urn">{s.urn.startsWith('SEM-')?'—':s.urn}</span><span className={`phone ${whatsappPhone(s.phone)?'':'phone-invalid'}`}>{s.phone||'sem telefone'}</span></td>
            <td>{responded?<span className="status answered"><Check size={13}/>Respondeu {date(responded)}</span>:ready?<span className="status pending">Pendente</span>:<span className="status neutral">Aguardando prazo</span>}</td>
            <td>{url?<div className="send-cell"><a className="whatsapp-button" href={url} target="_blank" rel="noopener noreferrer" aria-label={`WhatsApp para ${s.urn}`} onClick={()=>void send(s)}><MessageSquare size={15}/>WhatsApp<ExternalLink size={12}/></a>{sent&&<small className="sent-note">Mensagem enviada em {dateTime(sent)}</small>}</div>
              :<div className="send-cell"><span className="muted small">{responded?'—':s.safeguarding?'Não enviar: falar com a equipe MERL':!ready?`Aguardar ${date(due)}`:!whatsappPhone(s.phone)?'Telefone indisponível':!survey?.url?'Link do formulário pendente':'—'}</span>{sent&&<small className="sent-note">Mensagem enviada em {dateTime(sent)}</small>}</div>}</td>
          </tr>;})}
      </tbody></table></div>:<div className="empty"><p>Nenhum resultado.</p></div>}
    </section>
    <footer><span>MERL · ARCA</span></footer>
  </div>;
}
function pseudoClass(b:Board):ClassRow{return {id:'',code:'',partner:'',management_imported:true,...b.class};}
function pseudoSurvey(s:BoardSurvey):Survey{return {id:'',class_id:'',due_date:s.due_date,code:s.code,name:s.name,url:s.url,message_template:s.message_template};}
