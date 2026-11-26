import { useMemo,useState } from 'react';
import { PieChart,Users } from 'lucide-react';
import { classLabel,formLabel,submissionForm,type Dataset,type FormCode } from './domain';

// Dimensões demográficas do Kobo, detectadas pelo nome da coluna no export.
const DIMENSIONS:[string,RegExp][]=[
  ['Gênero',/SN8_How/i],
  ['Faixa etária',/SN7_Which_age/i],
  ['Raça/cor',/SN9_What_is_your_race/i],
  ['Escolaridade',/SN13_What_is_the_highest/i],
  ['Estado civil',/SN10_What_is_your_current_status/i],
  ['Renda atual',/SN1_Do_you_currently_earn/i],
  ['Deficiência',/SN11_Living_with/i],
];
// Os valores chegam como códigos do formulário; o que não estiver aqui é humanizado.
const LABELS:Record<string,string>={
  female:'Feminino',male:'Masculino',other:'Outro',prefer_not_to_say:'Prefere não dizer',prefer_not_to_answer:'Prefere não responder',
  '18_24':'18 a 24','25_35':'25 a 35','36_55':'36 a 55',above_55:'Acima de 55',under_18:'Menos de 18',
  parda:'Parda',branca:'Branca',preta:'Preta',amarela:'Amarela',indigena:'Indígena',
  single:'Solteira(o)',married:'Casada(o)',divorced:'Divorciada(o)',separated:'Separada(o)',widowed:'Viúva(o)',
  yes:'Sim',no:'Não',dont_know:'Não sabe',
  primary:'Ensino fundamental',secondary:'Ensino médio',technical:'Técnico/profissionalizante',university:'Ensino superior',
  formal_salaried:'Emprego formal assalariado',self_employed:'Autônoma(o)',daily_wage:'Trabalho por diária',
  not_earning:'Não possui renda',more_than_one:'Mais de uma fonte',
};
const humanize=(code:string)=>LABELS[code]??code.replace(/^\d+__/,'').replace(/_/g,' ').replace(/^\w/,c=>c.toUpperCase());

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
  const dimensions=useMemo(()=>DIMENSIONS.map(([label,pattern])=>{
    const counts=new Map<string,number>();
    for(const s of linked){
      const key=Object.keys(s.answers).find(k=>pattern.test(k));if(!key)continue;
      const value=String(s.answers[key]??'').trim();if(!value)continue;
      counts.set(value,(counts.get(value)||0)+1);
    }
    const total=Array.from(counts.values()).reduce((a,b)=>a+b,0);
    return {label,total,rows:Array.from(counts.entries()).map(([code,n])=>({code,label:humanize(code),n})).sort((a,b)=>b.n-a.n)};
  }).filter(d=>d.total>0),[linked]);
  return <>
    <div className="page-heading"><div><h1>Métricas · {formLabel(formCode)}</h1><p>Perfil das pessoas participantes a partir das respostas vinculadas. Contagens, nunca respostas individuais.</p></div>
      <label className="survey-selector inline"><span className="sr-only">Turma</span><select value={classId} onChange={e=>setClassId(e.target.value)}><option value="todas">Todas as turmas</option>{data.classes.map(c=><option key={c.id} value={c.id}>{classLabel(c)}</option>)}</select></label></div>
    <div className="metrics compact"><div className="metric"><div><span>Pessoas com resposta vinculada</span><span className="metric-icon"><Users size={18}/></span></div><strong>{linked.length}</strong></div>
      <div className="metric"><div><span>Dimensões disponíveis</span><span className="metric-icon"><PieChart size={18}/></span></div><strong>{dimensions.length}</strong></div></div>
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
