import Papa from 'papaparse';
export type ManagedClass={code:string;name:string;shift:string;starts_on:string;ends_on:string;followup_on:string;url:string;source:Record<string,unknown>};
export function parseDate(value:unknown):string|null {
  const s=String(value??'').trim();let y:number,m:number,d:number;
  const br=s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);const iso=s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if(br){d=+br[1];m=+br[2];y=+br[3];}else if(iso){y=+iso[1];m=+iso[2];d=+iso[3];}else return null;
  const date=new Date(Date.UTC(y,m-1,d));if(date.getUTCFullYear()!==y||date.getUTCMonth()!==m-1||date.getUTCDate()!==d)return null;
  return date.toISOString().slice(0,10);
}
export function plusDays(date:string,days:number){const d=new Date(`${date}T12:00:00Z`);d.setUTCDate(d.getUTCDate()+days);return d.toISOString().slice(0,10);}
export function brazilToday(date=new Date()){return new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'}).format(date);}
const key=(s:unknown)=>String(s??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]/g,'');
export function parseManagement(text:string){
  // The attached export has unused, repeated blank headers; only named columns are used.
  const parsed=Papa.parse<string[]>(text.replace(/^\uFEFF/,''),{skipEmptyLines:'greedy'});
  if(parsed.errors.length)throw new Error('CSV inválido.');
  const matrix=parsed.data;const h=matrix.findIndex(r=>r.some(x=>['idturma','turma'].includes(key(x))));
  if(h<0)throw new Error('Coluna ID_Turma não encontrada.');
  const header=matrix[h];const index=(names:string[])=>header.findIndex(x=>names.includes(key(x)));
  const columns={code:index(['idturma','turma']),name:index(['centrodetreinamento','centro','local']),shift:index(['turno']),start:index(['iniciodaturma','iniciodasaulas','inicio']),end:index(['conclusaodaturma','fimdaturma','conclusao','termino']),url:index(['urldivulgacao','form4url','linkform4'])};
  if(columns.start<0||columns.end<0)throw new Error('Informe Início da Turma e Conclusão da Turma.');
  const rows:ManagedClass[]=[];const errors:string[]=[];
  for(let i=h+1;i<matrix.length;i++){
    const r=matrix[i];const raw=String(r[columns.code]??'').trim();if(!/^T\d{1,4}$/i.test(raw))continue;
    const code='T'+raw.slice(1).padStart(2,'0');const start=parseDate(r[columns.start]),end=parseDate(r[columns.end]);
    if(!start||!end||end<start){errors.push(`${code}: datas inválidas.`);continue;}
    const existing=rows.find(x=>x.code===code);if(existing){if(existing.starts_on!==start||existing.ends_on!==end)errors.push(`${code}: datas divergentes em linhas repetidas.`);continue;}
    const url=String(r[columns.url]??'').trim();const source:Record<string,unknown>={};header.forEach((name,j)=>{if(name.trim()&&!Object.hasOwn(source,name))source[name]=r[j]??'';});
    rows.push({code,name:String(r[columns.name]??'').trim()||code,shift:String(r[columns.shift]??'').trim(),starts_on:start,ends_on:end,followup_on:plusDays(end,21),url:/^https:\/\//.test(url)?url:'',source});
  }
  if(!rows.length&&!errors.length)errors.push('Nenhuma turma válida encontrada.');
  return {rows,errors};
}
