import type { TextItem } from 'pdfjs-dist/types/src/display/api';
import { parseAttendancePage,type TextAtom,type AttendanceRow } from './attendance-layout';
export type AttendanceResult={rows:AttendanceRow[];pages:string[];warnings:string[];usedOCR:boolean};
export async function readAttendancePDF(file:File,onProgress:(text:string)=>void):Promise<AttendanceResult>{
  if(!/\.pdf$/i.test(file.name))throw new Error('Selecione um PDF.');if(file.size>20*1024*1024)throw new Error('PDF limitado a 20 MB.');
  const pdfjs=await import('pdfjs-dist');const workerUrl=(await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
  pdfjs.GlobalWorkerOptions.workerSrc=workerUrl;
  const base=new URL(import.meta.env.BASE_URL,window.location.href).href;
  const loading=pdfjs.getDocument({data:new Uint8Array(await file.arrayBuffer()),standardFontDataUrl:base+'pdf-fonts/',cMapUrl:base+'pdf-cmaps/',cMapPacked:true});
  let pdf;let ocrWorker:import('tesseract.js').Worker|undefined;
  const rows:AttendanceRow[]=[];const pages:string[]=[];const warnings:string[]=[];let usedOCR=false;
  try{
    pdf=await loading.promise;if(pdf.numPages>25)throw new Error('PDF limitado a 25 páginas.');
    for(let n=1;n<=pdf.numPages;n++){
      onProgress(`Lendo página ${n}/${pdf.numPages}`);const page=await pdf.getPage(n);const viewport=page.getViewport({scale:1});const content=await page.getTextContent();
      let atoms:TextAtom[]=content.items.filter((item):item is TextItem=>'str' in item).map(item=>{const tx=pdfjs.Util.transform(viewport.transform,item.transform);return {text:item.str,x:tx[4],y:tx[5],width:item.width,height:item.height};});
      const rendering=page.getViewport({scale:2.5});const canvas=document.createElement('canvas');canvas.width=Math.round(rendering.width);canvas.height=Math.round(rendering.height);const ctx=canvas.getContext('2d')!;
      await page.render({canvas,canvasContext:ctx,viewport:rendering}).promise;
      let extracted=parseAttendancePage(atoms,viewport.width,n);
      // No usable text layer: OCR runs locally with locally bundled workers and language data.
      if(!extracted.length){
        onProgress(`Reconhecendo página ${n}/${pdf.numPages}`);
        if(!ocrWorker){const {createWorker}=await import('tesseract.js');ocrWorker=await createWorker('por',1,{workerPath:base+'ocr/worker.min.js',corePath:base+'ocr/core',langPath:base+'ocr/lang',cacheMethod:'none',logger:m=>{if(m.status==='recognizing text')onProgress(`Página ${n}: ${Math.round((m.progress||0)*100)}%`);}});}
        const {data}=await ocrWorker.recognize(canvas,{}, {blocks:true});
        atoms=(data.blocks||[]).flatMap(b=>b.paragraphs.flatMap(p=>p.lines.flatMap(l=>l.words.map(w=>({text:w.text,x:w.bbox.x0/2.5,y:w.bbox.y1/2.5,width:(w.bbox.x1-w.bbox.x0)/2.5,height:(w.bbox.y1-w.bbox.y0)/2.5,confidence:w.confidence})))));
        extracted=parseAttendancePage(atoms,viewport.width,n,true);usedOCR=true;
      }
      if(!extracted.length)warnings.push(`Página ${n}: nenhuma matrícula identificada. Confira o PDF ou adicione os participantes manualmente.`);
      rows.push(...extracted);const blob=await new Promise<Blob>((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(new Error('Falha ao gerar página.')),'image/png'));pages.push(URL.createObjectURL(blob));
      canvas.width=canvas.height=1;page.cleanup();
    }
    const seen=new Map<string,AttendanceRow>();const merged:AttendanceRow[]=[];
    for(const row of rows){const previous=seen.get(row.urn);if(previous&&previous.name===row.name&&previous.phone===row.phone)continue;if(previous){previous.attention.push('Matrícula repetida');row.attention.push('Matrícula repetida');}else seen.set(row.urn,row);merged.push(row);}
    return {rows:merged,pages,warnings,usedOCR};
  }catch(error){pages.forEach(URL.revokeObjectURL);throw error;}finally{await ocrWorker?.terminate();await loading.destroy();}
}
