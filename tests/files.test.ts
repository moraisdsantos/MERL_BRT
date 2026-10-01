import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { readDataset } from '../src/import-file';
test('CSV and TSV exports are parsed with original columns and quoted values preserved',async()=>{
  const csv=new File(['matricula,nome,resposta\nL-B1-0001,"Maria, Exemplo","Texto com vírgula, e acento"'], 'dataset.csv');
  const parsed=await readDataset(csv);
  assert.equal(parsed[0].nome,'Maria, Exemplo');assert.equal(parsed[0].resposta,'Texto com vírgula, e acento');
  const tsv=new File(['matricula\tnome\nL-B1-0001\tMaria'], 'dataset.tsv');
  assert.equal((await readDataset(tsv))[0].matricula,'L-B1-0001');
  await assert.rejects(()=>readDataset(new File(['content'],'dataset.xls')),/CSV, TSV ou XLSX/);
});
test('XLSX first worksheet preserves answers and converts dates to ISO',async()=>{
  const wb=new ExcelJS.Workbook();const sheet=wb.addWorksheet('Responses');
  sheet.addRow(['matricula','nome','submitted_at','Resposta']);
  sheet.addRow(['L-B1-0001','Maria',new Date('2026-09-28T13:00:00Z'),'Completa']);
  const bytes=await wb.xlsx.writeBuffer();
  const parsed=await readDataset(new File([new Uint8Array(bytes)],'responses.xlsx'));
  assert.equal(parsed[0].matricula,'L-B1-0001');assert.equal(parsed[0].Resposta,'Completa');
  assert.equal(parsed[0].submitted_at,'2026-09-28T13:00:00.000Z');
});
