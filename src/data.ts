import { supabase } from './client';
import { emptyDataset, type Dataset, type ImportKind, type ImportRow, type Profile, type Survey } from './domain';
async function allRows(table:string) {
  const all:unknown[]=[];
  for(let offset=0;;offset+=500) {
    const firstKey=({enrollments:'student_id',class_access:'user_id',response_answers:'response_id'} as Record<string,string>)[table]||'id';
    const selection:string=table==='classes'?'id,code,name,partner,starts_on,ends_on,followup_on,shift,management_imported':table==='source_imports'?'id,kind,filename,imported_at,row_count,metadata':'*';
    let q=supabase!.from(table).select(selection).order(firstKey);
    if(table==='enrollments'||table==='class_access')q=q.order('class_id');
    const {data,error}=await q.range(offset,offset+499);
    if(error) throw error;
    all.push(...data);
    if(data.length<500) return all;
  }
}
export async function loadProfile(id:string):Promise<Profile> {
  const {data,error}=await supabase!.from('profiles').select('*').eq('id',id).single();
  if(error) throw error; return data;
}
export async function loadDataset(admin:boolean):Promise<Dataset> {
  const tables=['classes','surveys',...(admin?['students']:[]),'enrollments','response_status',...(admin?['response_answers','profiles','class_access','form4_submissions','source_imports']:[])];
  const results=await Promise.all(tables.map(allRows));
  const result=emptyDataset();
  tables.forEach((name,i)=>{const key=({response_status:'responses',response_answers:'answers',class_access:'assignments',form4_submissions:'submissions',source_imports:'sources'} as Record<string,string>)[name]||name;(result as unknown as Record<string,unknown>)[key]=results[i];});
  result.classes=result.classes.filter(c=>c.management_imported);
  if(!admin){
    for(let offset=0;;offset+=500){
      const {data,error}=await supabase!.rpc('get_partner_students').order('id').range(offset,offset+499);
      if(error)throw error;
      result.students.push(...(data||[]).map((s:{id:string;urn:string;phone:string})=>({...s,name:''})));
      if(!data||data.length<500)break;
    }
  }
  return result;
}
export async function rpc(name:string,args:Record<string,unknown>) {const {data,error}=await supabase!.rpc(name,args);if(error)throw error;return data;}
export const importLive=(classId:string,surveyId:string,kind:ImportKind,rows:ImportRow[],filename:string)=>rpc('import_dataset',{p_class_id:classId,p_survey_id:surveyId,p_kind:kind,p_rows:rows,p_filename:filename});
export async function saveSurvey(survey:Survey) {const {error}=await supabase!.from('surveys').upsert(survey);if(error)throw error;}
