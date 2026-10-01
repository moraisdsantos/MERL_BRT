import Papa from 'papaparse';
export async function readDataset(file:File):Promise<Record<string,unknown>[]> {
  if(file.size>10*1024*1024) throw new Error('O arquivo deve ter até 10 MB.');
  if(/\.xlsx$/i.test(file.name)) {
    const {default:ExcelJS}=await import('exceljs');
    const workbook=new ExcelJS.Workbook();
    await workbook.xlsx.load(await file.arrayBuffer());
    const sheet=workbook.worksheets[0];
    if(!sheet)throw new Error('A planilha não contém uma aba.');
    const text=(value:unknown):unknown=> {if(value instanceof Date)return value.toISOString();if(typeof value==='object'&&value!==null){const obj=value as Record<string,unknown>;if('result' in obj)return obj.result;if('text' in obj)return obj.text;if('richText' in obj)return (obj.richText as {text:string}[]).map(t=>t.text).join('');}return value??'';};
    const headers:string[]=[];
    sheet.getRow(1).eachCell({includeEmpty:true},(cell,col)=>{headers[col-1]=String(text(cell.value)).trim();});
    if(headers.some(h=>!h) || new Set(headers).size!==headers.length)throw new Error('Os cabeçalhos devem ser únicos e preenchidos.');
    const result:Record<string,unknown>[]=[];
    sheet.eachRow((row,index)=>{if(index===1)return;const record:Record<string,unknown>={};headers.forEach((h,i)=>{record[h]=text(row.getCell(i+1).value);});result.push(record);});
    if(result.length>5000)throw new Error('Importe no máximo 5.000 linhas por arquivo.');
    return result;
  }
  if(!/\.(csv|tsv)$/i.test(file.name))throw new Error('Use um arquivo CSV, TSV ou XLSX.');
  const result=Papa.parse<Record<string,unknown>>(await file.text(),{header:true,skipEmptyLines:'greedy',transformHeader:h=>h.replace(/^\uFEFF/,'').trim()});
  if(result.meta.renamedHeaders && Object.keys(result.meta.renamedHeaders).length)throw new Error('O arquivo contém cabeçalhos duplicados.');
  if(result.errors.length)throw new Error(`Não foi possível ler o arquivo: ${result.errors[0].message}`);
  if(result.data.length>5000)throw new Error('Importe no máximo 5.000 linhas por arquivo.');
  return result.data;
}
