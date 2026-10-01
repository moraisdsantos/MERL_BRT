import { type Dataset,type Form4Submission,type MatchCandidate,whatsappPhone } from './domain';
import { brazilToday } from './management';
export const normalizeName=(value:unknown)=>String(value??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase().replace(/[^A-Z\s]/g,' ').split(/\s+/).filter(t=>t&&!['DE','DA','DO','DAS','DOS','E'].includes(t)).join(' ');
export const compactURN=(value:unknown)=>String(value??'').trim().toUpperCase().replace(/[^A-Z0-9]/g,'');
function similarity(a:string,b:string){if(a===b)return 1;if(!a||!b)return 0;let prev=Array.from({length:b.length+1},(_,i)=>i);for(let i=1;i<=a.length;i++){const row=[i];for(let j=1;j<=b.length;j++)row[j]=Math.min(row[j-1]+1,prev[j]+1,prev[j-1]+Number(a[i-1]!==b[j-1]));prev=row;}return 1-prev[b.length]/Math.max(a.length,b.length);}
export function nameScore(a:unknown,b:unknown){
  const na=normalizeName(a),nb=normalizeName(b);if(!na||!nb)return {score:0,reason:'Nome ausente'};
  if(na===nb)return {score:1,reason:'Nome equivalente'};
  const ta=na.split(' '),tb=nb.split(' ');const shorter=ta.length<=tb.length?ta:tb,longer=ta.length<=tb.length?tb:ta;
  const subset=shorter.every((token,i)=>{let prior=-1;for(let j=0;j<=i;j++){prior=longer.indexOf(shorter[j],prior+1);if(prior<0)return false;}return true;});
  const anchors=ta[0]===tb[0]&&ta.at(-1)===tb.at(-1);
  if(anchors&&subset&&shorter.length>=3)return {score:.95,reason:'Nome do meio abreviado'};
  if(anchors&&subset&&shorter.length===2)return {score:.84,reason:'Nome incompleto'};
  const tokenOverlap=ta.filter(t=>tb.includes(t)).length/Math.max(ta.length,tb.length);
  const score=similarity(na,nb)*.65+tokenOverlap*.25+(anchors?.1:0);
  return {score:Math.min(.94,score),reason:'Variação de nome'};
}
export function timingFlags(date:string|null,classId:string,data:Dataset){const c=data.classes.find(c=>c.id===classId);if(!date)return ['Data da resposta ausente'];const day=brazilToday(new Date(date));if(c?.starts_on&&day<c.starts_on)return ['Resposta anterior à turma'];if(c?.followup_on&&day<c.followup_on)return ['Resposta antes de 3 semanas'];return [];}
export function matchSubmission(urn:string,name:string,phone:string,date:string|null,data:Dataset){
  const id=compactURN(urn),validId=/^[LT][A-Z]\d+[A-Z0-9]*$/.test(id);const phoneId=whatsappPhone(phone);
  const candidates:MatchCandidate[]=[];let identityConflict=false;
  for(const enrollment of data.enrollments.filter(e=>!e.excluded&&e.attendance_verified!==false)){
    const s=data.students.find(s=>s.id===enrollment.student_id);if(!s)continue;const ns=nameScore(name,s.name);
    const exact=!!id&&validId&&compactURN(s.urn)===id&&!s.urn.startsWith('SEM-');
    const samePhone=!!phoneId&&phoneId===whatsappPhone(s.phone);
    const score=exact?1:Math.min(.99,ns.score+(samePhone?.035:0));
    if(exact||score>=.58)candidates.push({student_id:s.id,class_id:enrollment.class_id,score,reason:exact?'Matrícula equivalente':samePhone?ns.reason+' e telefone':ns.reason});
    if(exact&&ns.score<.84)identityConflict=true;
  }
  candidates.sort((a,b)=>b.score-a.score||Number(b.reason==='Matrícula equivalente')-Number(a.reason==='Matrícula equivalente')||a.class_id.localeCompare(b.class_id)||a.student_id.localeCompare(b.student_id));
  const best=candidates[0];const second=candidates[1];const flags:string[]=[];
  if(!best)return {state:'review' as const,student_id:null,class_id:null,candidates:[],flags:['Sem correspondência']};
  const student=data.students.find(s=>s.id===best.student_id)!;const n=nameScore(name,student.name);
  const equalURN=validId&&compactURN(student.urn)===id;
  const ambiguous=equalURN?candidates.filter(c=>c.reason==='Matrícula equivalente').length>1:!!second&&(best.score-second.score<.075);
  const urnConflict=!!urn.trim()&&!equalURN;
  const phoneConflict=!!phoneId&&!!whatsappPhone(student.phone)&&phoneId!==whatsappPhone(student.phone);
  const countryCodeConflict=validId&&!/^[LT]B\d/.test(id);
  if(identityConflict)flags.push('Matrícula e nome divergentes');
  if(ambiguous)flags.push('Mais de uma correspondência');
  if(urnConflict)flags.push('Matrícula divergente');
  if(!urn.trim())flags.push('Matrícula ausente no Form 4');
  if(phoneConflict)flags.push('Telefone divergente');
  if(countryCodeConflict)flags.push('Código de país na matrícula');
  if(n.reason!=='Nome equivalente')flags.push(n.reason);
  const temporal=timingFlags(date,best.class_id,data);flags.push(...temporal);
  const safeName=n.score>=.95;
  const automatic=!ambiguous&&!identityConflict&&!urnConflict&&!phoneConflict&&!countryCodeConflict&&!!date&&!temporal.includes('Resposta anterior à turma')&&(equalURN?n.score>=.84:safeName&&best.score>=.95);
  if(!automatic&&!flags.length)flags.push('Conferir correspondência');
  return {state:automatic?'linked' as const:'review' as const,student_id:automatic?best.student_id:null,class_id:automatic?best.class_id:null,candidates:candidates.slice(0,5),flags:Array.from(new Set(flags))};
}
export function form4Columns(headers:string[]){const find=(pattern:RegExp,aliases:string[])=>headers.find(h=>pattern.test(h))||headers.find(h=>aliases.includes(h.toLowerCase()))||'';return {urn:find(/A1.*URN/i,['matricula','urn']),name:find(/A2.*name/i,['nome','name']),country:find(/A3_Country$/i,['pais','country']),phone:find(/X5.*telephone/i,['telefone','phone']),date:find(/^_submission_time$/i,['submitted_at','responded_at'])};}
async function digest(record:Record<string,unknown>){const canonical=JSON.stringify(Object.fromEntries(Object.entries(record).sort(([a],[b])=>a.localeCompare(b))));const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonical));return Array.from(new Uint8Array(hash)).map(b=>b.toString(16).padStart(2,'0')).join('');}
export async function prepareForm4(records:Record<string,unknown>[],data:Dataset){
  const columns=form4Columns(Object.keys(records[0]||{}));if(!columns.name&&!columns.urn)throw new Error('Campos de nome ou matrícula não encontrados.');
  const rows:Omit<Form4Submission,'id'>[]=[];let other=0;let repeated=0;const seen=new Set<string>();
  for(const raw of records){
    const country=String(raw[columns.country]??'').trim();const isBrazil=/brasil|brazil/i.test(country);
    if(country&&!isBrazil){other++;continue;}
    const external_id=String(raw._uuid||raw['meta/instanceID']||raw._id||await digest(raw));if(seen.has(external_id)){repeated++;continue;}seen.add(external_id);
    const source_name=String(raw[columns.name]??'').trim(),source_urn=String(raw[columns.urn]??'').trim(),source_phone=String(raw[columns.phone]??'').trim();
    const value=raw[columns.date];const parsed=value?new Date(String(value)):null;const submitted_at=parsed&&!Number.isNaN(parsed.getTime())?parsed.toISOString():null;
    const existing=data.submissions.find(s=>s.external_id===external_id);
    let decision:{state:Form4Submission['state'];student_id:string|null;class_id:string|null;candidates:MatchCandidate[];flags:string[]}=matchSubmission(source_urn,source_name,source_phone,submitted_at,data);
    let match_origin:'manual'|'auto'='auto';let review_reason='';
    if(existing?.match_origin==='manual'){
      match_origin='manual';review_reason=existing.review_reason;
      const changed=compactURN(existing.source_urn)!==compactURN(source_urn)||normalizeName(existing.source_name)!==normalizeName(source_name);
      decision={...decision,state:existing.state,student_id:existing.student_id,class_id:existing.class_id,flags:Array.from(new Set([...existing.flags,...(existing.class_id?timingFlags(submitted_at,existing.class_id,data):[]),...(changed?['Identificação alterada na origem']:[])]))};
    }
    if(!country){decision.state='review';decision.student_id=null;decision.class_id=null;decision.flags.push('País não informado');}
    rows.push({external_id,source_urn,source_name,source_phone,country,submitted_at,...decision,answers:raw,match_origin,review_reason});
  }
  const counts=new Map<string,number>();for(const row of rows){if(row.student_id&&row.class_id){const k=row.student_id+row.class_id;counts.set(k,(counts.get(k)||0)+1);}}
  rows.forEach(row=>{if(row.student_id&&row.class_id&&(counts.get(row.student_id+row.class_id)||0)>1)row.flags.push('Respostas duplicadas');});
  return {rows,other,repeated,linked:rows.filter(r=>r.state==='linked').length,review:rows.filter(r=>r.state==='review').length};
}
export function reconcileForm4(data:Dataset):Form4Submission[]{
  return data.submissions.map(s=>{
    if(s.match_origin==='manual')return {...s};
    const decision=matchSubmission(s.source_urn,s.source_name,s.source_phone,s.submitted_at,data);
    if(!/brasil|brazil/i.test(s.country)){decision.state='review';decision.student_id=null;decision.class_id=null;decision.flags.push('Conferir país');}
    return {...s,...decision};
  });
}
