export type Role = 'admin' | 'partner';
export type ClassRow = { id: string; code: string; name: string; partner: string; starts_on?:string|null; ends_on?:string|null; followup_on?:string|null; shift?:string; management_imported?:boolean };
export type Survey = { id: string; class_id: string; code: string; name: string; url: string; due_date: string | null; message_template: string };
export type Student = { id: string; urn: string; name: string; phone: string };
export type Enrollment = { class_id: string; student_id: string; excluded: boolean; exclusion_reason: string; attention?:string[]; review_pending?:boolean; attendance_verified?:boolean };
export type ResponseRow = { id: string; class_id: string; survey_id: string; student_id: string; responded_at: string; attention?:string[] };
export type AnswerRow = { response_id: string; answers: Record<string, unknown> };
export type Profile = { id: string; email: string; full_name: string; role: Role };
export type Assignment = { user_id: string; class_id: string };
export type Dataset = { classes: ClassRow[]; surveys: Survey[]; students: Student[]; enrollments: Enrollment[]; responses: ResponseRow[]; answers: AnswerRow[]; profiles: Profile[]; assignments: Assignment[]; submissions:Form4Submission[]; sources:SourceImport[] };
export type MatchCandidate={student_id:string;class_id:string;score:number;reason:string};
export type Form4Submission={id:string;external_id:string;source_urn:string;source_name:string;source_phone:string;country:string;submitted_at:string|null;student_id:string|null;class_id:string|null;state:'linked'|'review'|'ignored';flags:string[];candidates:MatchCandidate[];answers:Record<string,unknown>;match_origin:'auto'|'manual';review_reason:string};
export type SourceImport={id:string;kind:'management'|'attendance'|'form4';filename:string;imported_at:string;row_count:number;metadata:Record<string,unknown>};
export type ImportKind = 'roster' | 'responses';
export type Mapping = { urn: string; name: string; phone: string; status: string; submittedAt: string };
export type ImportRow = { urn: string; name: string; phone: string; responded: boolean; submitted_at: string | null; answers: Record<string, unknown> };
export const DEFAULT_MESSAGE = 'Olá, {nome}! Tudo bem? Aqui é a equipe do projeto SIDP — British Council, Fase V. Sua participação na pesquisa {pesquisa}, da turma {turma}, é muito importante.\n\nVocê pode responder pelo link: {link}\n\nSua matrícula é {matricula}. Se já respondeu, por favor nos avise. Obrigado!\nEquipe MERL · ARCA';
export const emptyDataset = (): Dataset => ({classes:[],surveys:[],students:[],enrollments:[],responses:[],answers:[],profiles:[],assignments:[],submissions:[],sources:[]});
export const normalizeURN = (value: unknown) => String(value ?? '').trim().toUpperCase().replace(/[–—]/g, '-');
export function whatsappPhone(value: unknown): string | null {
  const raw = String(value ?? '').trim();
  let digits = raw.replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (!raw.startsWith('+') && !raw.startsWith('00') && (digits.length === 10 || digits.length === 11)) digits = '55' + digits;
  // Brazilian DDD + 8/9 digit local number, or explicit international E.164.
  if (digits.startsWith('55')) return /^55[1-9]\d(?:9\d{8}|[2-5]\d{7})$/.test(digits) ? digits : null;
  return /^(?:\+|00)/.test(raw) && /^[1-9]\d{7,14}$/.test(digits) ? digits : null;
}
export function renderMessage(template: string, student: Student, classroom: ClassRow, survey: Survey) {
  const variables: Record<string,string> = {nome:student.name.split(' ')[0],nome_completo:student.name,turma:classroom.code,pesquisa:survey.name,link:survey.url,matricula:student.urn};
  return template.replace(/\{(nome_completo|nome|turma|pesquisa|link|matricula)\}/g, (_, key:string) => variables[key]);
}
export const validSurveyUrl = (url: string) => { try { return new URL(url).protocol === 'https:'; } catch { return false; } };
export function whatsappUrl(student: Student, classroom: ClassRow, survey: Survey) {
  const phone = whatsappPhone(student.phone);
  if (!phone || !validSurveyUrl(survey.url)) return null;
  return `https://web.whatsapp.com/send?phone=${phone}&text=${encodeURIComponent(renderMessage(survey.message_template,student,classroom,survey))}`;
}
export function classStudents(data: Dataset, classId: string) {
  const enrolled = new Map(data.enrollments.filter(e=>e.class_id===classId).map(e=>[e.student_id,e]));
  return data.students.filter(s=>enrolled.has(s.id)).map(s=>({...s,enrollment:enrolled.get(s.id)!})).sort((a,b)=>a.name.localeCompare(b.name,'pt-BR'));
}
export function responseFor(data: Dataset, surveyId: string, studentId: string) { return data.responses.find(r=>r.survey_id===surveyId && r.student_id===studentId); }
export function stats(data:Dataset, classroom:ClassRow, survey?:Survey) {
  const students = classStudents(data,classroom.id).filter(s=>!s.enrollment.excluded&&s.enrollment.attendance_verified!==false);
  const answered = survey ? students.filter(s=>responseFor(data,survey.id,s.id)).length : 0;
  return {total:students.length,answered,pending:survey?students.length-answered:0,percent:students.length? Math.round(100*answered/students.length):0};
}
const simplify = (s:unknown) => String(s??'').trim().normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
export function parseResponseStatus(value: unknown): boolean | null {
  const s=simplify(value);
  if (['sim','yes','true','1','respondido','respondeu','answered','completed','complete'].includes(s)) return true;
  if (['','nao','no','false','0','pendente','pending','nao respondeu','nao respondido','not answered','not responded'].includes(s)) return false;
  return null;
}
export function inferMapping(headers:string[]): Mapping {
  const find=(names:string[])=>headers.find(h=>names.includes(simplify(h)))||'';
  return {urn:find(['urn','matricula','numero de matricula','student_id','registration','id']),name:find(['nome','name','nome completo','student_name','full_name']),phone:find(['telefone','phone','whatsapp','celular','phone_number']),status:find(['status','respondido','respondeu','answered','response_status']),submittedAt:find(['submitted_at','submission_time','respondido_em','responded_at','data de resposta','_submission_time'])};
}
export function prepareImport(records:Record<string,unknown>[], mapping:Mapping, kind:ImportKind, existing:Student[]) {
  const rows:ImportRow[]=[]; const errors:string[]=[]; const warnings:string[]=[]; const seen=new Set<string>();
  records.forEach((raw,i)=>{
    if (Object.values(raw).every(v=>v===null || v===undefined || String(v).trim()==='')) return;
    const urn=normalizeURN(raw[mapping.urn]);
    const name=String(raw[mapping.name]??'').trim(); const phone=String(raw[mapping.phone]??'').trim();
    const rowErrors:string[]=[];
    if (!urn || /\s/.test(urn)) rowErrors.push('matrícula ausente ou com espaços');
    if (urn && seen.has(urn)) rowErrors.push(`matrícula duplicada (${urn})`);
    seen.add(urn);
    if (!name && !existing.some(s=>s.urn===urn)) rowErrors.push('nome obrigatório para novo participante');
    const responded=kind==='responses'?true:mapping.status?parseResponseStatus(raw[mapping.status]):false;
    if (responded===null) rowErrors.push('status não reconhecido');
    let submitted_at:string|null=null;
    const date=mapping.submittedAt ? raw[mapping.submittedAt] : null;
    if (responded && date!==null && date!==undefined && String(date).trim()!=='') {
      const parsed = date instanceof Date ? date : new Date(String(date));
      if(Number.isNaN(parsed.getTime())) rowErrors.push('data inválida; use o formato ISO (AAAA-MM-DD)');
      else submitted_at=parsed.toISOString();
    }
    if(phone && !whatsappPhone(phone)) warnings.push(`Linha ${i+2}: telefone inválido; WhatsApp ficará indisponível.`);
    if(rowErrors.length) errors.push(`Linha ${i+2}: ${rowErrors.join('; ')}.`);
    else rows.push({urn,name,phone,responded:responded!,submitted_at,answers:raw});
  });
  return {rows,errors,warnings};
}
