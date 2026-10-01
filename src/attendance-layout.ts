import { normalizeURN, whatsappPhone } from './domain';
export type TextAtom={text:string;x:number;y:number;width:number;height:number;confidence?:number};
export type AttendanceRow={key:string;urn:string;name:string;phone:string;page:number;include:boolean;attention:string[];source_text:string};
const urnPattern=/\b[LT]\s*[-–—]?\s*[BNIKSU]\s*[-–—]?\s*\d{1,2}\s*[-–—]?\s*\d{3,5}\b/gi;
// Parse by table coordinates, not PDF stream order, which often lists entire columns separately.
export function parseAttendancePage(atoms:TextAtom[],width:number,page:number,ocr=false):AttendanceRow[]{
  // PDF.js sometimes combines the matrícula and first name into a single text item.
  atoms=atoms.flatMap(atom=>{
    const match=Array.from(atom.text.matchAll(urnPattern))[0];if(!match||match[0].trim()===atom.text.trim())return [atom];
    const index=match.index||0,end=index+match[0].length,total=Math.max(atom.text.length,1);
    const pieces:TextAtom[]=[];
    if(atom.text.slice(0,index).trim())pieces.push({...atom,text:atom.text.slice(0,index).trim(),width:atom.width*index/total});
    pieces.push({...atom,text:match[0],x:atom.x+atom.width*index/total,width:atom.width*match[0].length/total});
    if(atom.text.slice(end).trim())pieces.push({...atom,text:atom.text.slice(end).trim(),x:atom.x+atom.width*end/total,width:atom.width*(total-end)/total});
    return pieces;
  });
  const headerPhone=atoms.find(a=>/^telefone$/i.test(a.text.trim()));const headerAge=atoms.find(a=>/^(idade|ldade)$/i.test(a.text.trim()));
  let phoneStart=headerPhone?headerPhone.x-width*.022:width*.38;const phoneEnd=headerAge?headerAge.x-width*.006:width*.48;
  const anchors=atoms.flatMap(a=>Array.from(a.text.matchAll(urnPattern),m=>({atom:a,urn:normalizeURN(m[0].replace(/\s+/g,'')),x:a.x+(m.index||0)/Math.max(a.text.length,1)*a.width,y:a.y}))).filter(a=>a.x<width*.2).sort((a,b)=>a.y-b.y);
  const numericPhones=atoms.filter(a=>a.x>width*.25&&a.x<width*.6&&/^[+\d\s().-]+$/.test(a.text)&&a.text.replace(/\D/g,'').length>=8);
  if(numericPhones.length)phoneStart=Math.min(phoneStart,...numericPhones.map(a=>Math.min(a.x,...atoms.filter(p=>Math.abs(p.y-a.y)<4&&p.x>=a.x-18&&p.x<a.x&&/^\d{2}$/.test(p.text.trim())).map(p=>p.x))-1));
  const rows:AttendanceRow[]=[];
  for(let i=0;i<anchors.length;i++){
    const a=anchors[i];const before=i?anchors[i-1].y:a.y-24;const after=anchors[i+1]?.y??a.y+24;
    if(i&&Math.abs(before-a.y)<3)continue;
    const minY=a.y-Math.min(12,(a.y-before)*.45);const maxY=a.y+Math.min(14,(after-a.y)*.55);
    const line=atoms.filter(w=>w.y>=minY&&w.y<maxY).sort((u,v)=>Math.abs(u.y-v.y)>6?u.y-v.y:u.x-v.x);
    const nameStart=width*.10;
    const name=line.filter(w=>w.x>=nameStart&&w.x<phoneStart).map(w=>w.text).join(' ').replace(/\s+/g,' ').trim();
    const phone=line.filter(w=>w.x>=phoneStart&&w.x<phoneEnd).map(w=>w.text).join('').replace(/[^+\d]/g,'');
    const attention:string[]=[];if(ocr)attention.push('Texto reconhecido por OCR');if(name.split(/\s+/).length<2)attention.push('Nome incompleto');if(!name)attention.push('Nome não identificado');if(phone&&!whatsappPhone(phone))attention.push('Telefone inválido');if(!/^[LT]-?B/i.test(a.urn))attention.push('Código de país na matrícula');
    rows.push({key:`${page}-${i}`,urn:a.urn,name,phone,page,include:true,attention,source_text:line.map(w=>w.text).join(' ')});
  }
  return rows;
}
