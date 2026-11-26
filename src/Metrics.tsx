import { useMemo,useState } from 'react';
import { PieChart } from 'lucide-react';
import { classLabel,formLabel,submissionForm,type Dataset,type FormCode } from './domain';

// Dimensões demográficas do Kobo, detectadas pelo nome da coluna no export.
// Os valores chegam como códigos do formulário (ex.: "4__brown_mixed_race_parda");
// cada dimensão traduz os códigos para os rótulos em português usados no Brasil.
type Option={label:string;match:RegExp};
type Dimension={label:string;column:RegExp;options:Option[];showEmpty?:boolean};
const prefer:Option={label:'Prefiro não responder',match:/prefer/i};
const dontKnow:Option={label:'Não sei',match:/don_?t_know/i};
const DIMENSIONS:Dimension[]=[
  {label:'Gênero',column:/SN8_How/i,options:[{label:'Feminino',match:/female/i},{label:'Masculino',match:/(^|_)male/i},{label:'Outro',match:/other/i},prefer]},
  {label:'Faixa etária',column:/SN7_Which_age/i,options:[{label:'18 a 24 anos',match:/18_+24/},{label:'25 a 35 anos',match:/25_+35/},{label:'36 a 55 anos',match:/36_+55/},{label:'Acima de 55 anos',match:/over_55/i},prefer]},
  {label:'Raça/cor',column:/SN9_What_is_your_race/i,showEmpty:true,options:[{label:'Branca',match:/white/i},{label:'Preta',match:/black/i},{label:'Amarela',match:/yellow|asian/i},{label:'Parda',match:/brown|parda/i},{label:'Indígena',match:/indig|^5__/i},prefer]},
  {label:'Escolaridade',column:/SN13_What_is_the_highest/i,options:[{label:'Educação não formal',match:/non_formal/i},{label:'Ensino fundamental',match:/primary/i},{label:'Ensino médio',match:/secondary/i},{label:'Ensino técnico ou profissionalizante',match:/technical|vocational/i},{label:'Ensino superior',match:/university/i},dontKnow,prefer]},
  {label:'Estado civil',column:/SN10_What_is_your_current_status/i,options:[{label:'Solteira(o)',match:/single/i},{label:'Casada(o)',match:/married/i},{label:'Divorciada(o) ou separada(o)',match:/divorced|separated/i},{label:'Viúva(o)',match:/widow/i},dontKnow,prefer]},
  {label:'Renda atual',column:/SN1_Do_you_currently_earn/i,options:[
    {label:'Não tem renda',match:/^1__no$/i},
    {label:'Diária ou bico',match:/^2__yes___daily_wage/i},
    {label:'Emprego formal assalariado',match:/^3__yes___formal_salaried_job/i},
    {label:'Conta própria ou negócio próprio',match:/self_employed/i},
    {label:'Diária e negócio próprio',match:/both_daily_wage_side_business/i},
    {label:'Emprego assalariado e negócio próprio',match:/salaried.*side_?business|both_formal_salaried/i},
    {label:'Outro trabalho remunerado',match:/other_paid_work/i},
    prefer]},
  {label:'Pessoa com deficiência',column:/SN11_Living_with/i,options:[{label:'Sim',match:/yes/i},{label:'Não',match:/(^|_)no$/i},dontKnow,prefer]},
  {label:'Faixa de renda mensal (Brasil)',column:/SN2b_brazil/i,options:[1,2,3,4,5,6,7,8].map(n=>({label:`Faixa ${n}`,match:new RegExp(`_${n}$`)}))},
];
const classify=(dim:Dimension,value:string)=>dim.options.find(o=>o.match.test(value))?.label??'Outra resposta';

export default function Metrics({data,formCode}:{data:Dataset;formCode:FormCode}){
  const [classId,setClassId]=useState('todas');
  const linked=useMemo(()=>{
    const rows=data.submissions.filter(s=>s.state==='linked'&&submissionForm(s)===formCode&&(classId==='todas'||s.class_id===classId));
    // Uma pessoa por estudante: vale a resposta mais recente.
    const byStudent=new Map<string,typeof rows[number]>();
    for(const s of rows){const key=`${s.student_id}|${s.class_id}`;const prior=byStudent.get(key);
      if(!prior||String(s.submitted_at)>String(prior.submitted_at))byStudent.set(key,s);}
    return Array.from(byStudent.values());
  },[data,formCode,classId]);
  const dimensions=useMemo(()=>DIMENSIONS.map(dim=>{
    const counts=new Map<string,number>(dim.showEmpty?dim.options.map(o=>[o.label,0] as [string,number]):[]);
    for(const s of linked){
      const key=Object.keys(s.answers).find(k=>dim.column.test(k));if(!key)continue;
      const value=String(s.answers[key]??'').trim();if(!value)continue;
      const label=classify(dim,value);counts.set(label,(counts.get(label)||0)+1);
    }
    const total=Array.from(counts.values()).reduce((a,b)=>a+b,0);
    const order=(l:string)=>{const i=dim.options.findIndex(o=>o.label===l);return i<0?99:i;};
    return {label:dim.label,total,rows:Array.from(counts.entries()).map(([label,n])=>({code:label,label,n})).sort((a,b)=>b.n-a.n||order(a.label)-order(b.label))};
  }).filter(d=>d.total>0),[linked]);
  return <>
    <div className="page-heading"><div><h1>Métricas · {formLabel(formCode)}</h1><p>Perfil das pessoas participantes a partir das respostas vinculadas. Contagens, nunca respostas individuais.</p></div>
      <label className="survey-selector inline"><span className="sr-only">Turma</span><select value={classId} onChange={e=>setClassId(e.target.value)}><option value="todas">Todas as turmas</option>{[...data.classes].sort((a,b)=>String(a.starts_on).localeCompare(String(b.starts_on))||classLabel(a).localeCompare(classLabel(b),'pt-BR')).map(c=><option key={c.id} value={c.id}>{classLabel(c)} ({String(c.starts_on||'').slice(8,10)}/{String(c.starts_on||'').slice(5,7)})</option>)}</select></label></div>
    <div className="metrics compact"><div className="metric"><div><span>Pessoas com resposta vinculada</span></div><strong>{linked.length}</strong></div>
      <div className="metric"><div><span>Dimensões disponíveis</span></div><strong>{dimensions.length}</strong></div></div>
    {dimensions.length?<div className="metric-grid">{dimensions.map(d=><section className="panel metric-block" key={d.label}>
      <div className="metric-block-head"><h2>{d.label}</h2><span>{d.total} respostas</span></div>
      <ul className="bar-list">{d.rows.map(r=>{const pct=d.total?r.n/d.total*100:0;return <li key={r.code} title={`${r.label}: ${r.n} (${pct.toFixed(1).replace('.',',')}%)`}>
        <span className="bar-label">{r.label}</span>
        <span className="bar-track" aria-hidden="true"><span className="bar-fill" style={{width:`${Math.max(pct,1.5)}%`}}/></span>
        <span className="bar-value">{r.n}<small>{pct.toFixed(1).replace('.',',')}%</small></span>
      </li>;})}</ul>
    </section>)}</div>:<div className="empty"><PieChart size={25}/><p>Sem respostas vinculadas de {formLabel(formCode)} {classId==='todas'?'nas turmas importadas':'nesta turma'} até aqui. As métricas aparecem depois da importação e conferência das respostas.</p></div>}
  </>;
}
