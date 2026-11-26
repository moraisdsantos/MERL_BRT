import test from 'node:test';
import assert from 'node:assert/strict';
import { isMobileDevice, classStudents, inferMapping, normalizeURN, parseResponseStatus, prepareImport, stats, whatsappPhone, whatsappUrl, DEFAULT_MESSAGE } from '../src/domain';
import { demoDataset } from './fixtures';
test('Brazil and international WhatsApp numbers validate and normalize',()=>{
  assert.equal(whatsappPhone('(91) 99999-9999'),'5591999999999');
  assert.equal(whatsappPhone('+55 91 99999-9999'),'5591999999999');
  assert.equal(whatsappPhone('+44 7700 900123'),'447700900123');
  assert.equal(whatsappPhone('0044 7700 900123'),'447700900123');
  assert.equal(whatsappPhone('abc'),null);
  assert.equal(whatsappPhone('99999-9999'),null);
  assert.equal(whatsappPhone('5500999999999'),null);
});
test('WhatsApp URL fills the specific student, class, and survey, encoding the message',()=>{
  const data=demoDataset('admin');const s={...data.students[0],phone:'(91) 99999-9999'};
  const survey={...data.surveys[0],url:'https://example.org/survey?lang=pt&form=4',message_template:DEFAULT_MESSAGE};
  const url=new URL(whatsappUrl(s,data.classes[0],survey,false)!);
  assert.equal(url.host,'web.whatsapp.com');assert.equal(new URL(whatsappUrl(s,data.classes[0],survey,true)!).host,'api.whatsapp.com');
  assert.ok(isMobileDevice('Mozilla/5.0 (Linux; Android 14; SM-A146M) AppleWebKit/537.36 Chrome/131 Mobile Safari/537.36'));assert.ok(isMobileDevice('Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148'));assert.ok(!isMobileDevice('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36'));assert.equal(url.searchParams.get('phone'),'5591999999999');
  assert.match(url.searchParams.get('text')!,/Olá! Tudo bem\?/);assert.ok(!url.searchParams.get('text')!.includes('Ana'),'mensagem não carrega nome');assert.match(url.searchParams.get('text')!,/Piloto · Básico/);
  assert.ok(url.searchParams.get('text')!.includes(survey.url));assert.ok(url.searchParams.get('text')!.includes(s.urn));
  assert.equal(whatsappUrl(s,data.classes[0],{...survey,url:'javascript:alert(1)'}),null);
});
test('imports keep all answers, validate dates/status, and reject duplicate URNs',()=>{
  const records=[{matricula:'l–b1-0001',nome:'Maria',telefone:'bad',status:'sim',submitted_at:'2026-09-28T13:00:00Z',custom:'Full answer'}];
  const mapping=inferMapping(Object.keys(records[0]));
  const result=prepareImport(records,mapping,'roster',[]);
  assert.equal(result.errors.length,0);assert.equal(result.warnings.length,1);assert.equal(result.rows[0].urn,'L-B1-0001');
  assert.equal(result.rows[0].responded,true);assert.equal(result.rows[0].answers.custom,'Full answer');
  assert.equal(prepareImport([...records,...records],mapping,'responses',[]).errors.length,1);
  assert.equal(prepareImport([{...records[0],status:'maybe'}],mapping,'roster',[]).errors.length,1);
  assert.equal(prepareImport([{...records[0],submitted_at:'invalid'}],mapping,'responses',[]).errors.length,1);
  assert.equal(prepareImport([{...records[0],matricula:'L B1-0001'}],mapping,'responses',[]).errors.length,1);
  assert.equal(parseResponseStatus('não respondeu'),false);assert.equal(parseResponseStatus('pending'),false);assert.equal(parseResponseStatus('yes'),true);
  assert.equal(normalizeURN('  l-b1-0001  '),'L-B1-0001');
});
test('matching existing students permits answer files without name columns',()=>{
  const records=[{urn:'L-B1-0001',answer:'yes'}];const mapping=inferMapping(Object.keys(records[0]));
  assert.equal(prepareImport(records,mapping,'responses',[]).errors.length,1);
  assert.equal(prepareImport(records,mapping,'responses',[{id:'s',urn:'L-B1-0001',name:'Maria',phone:''}]).errors.length,0);
});
test('class denominators exclude inactive students, and partner demo exposes only assigned classes',()=>{
  const data=demoDataset('admin');const first={...data.classes[0],followup_on:'2026-01-01'};const survey=data.surveys[0];
  assert.deepEqual(stats(data,first,survey),{total:22,answered:16,pending:6,waiting:0,percent:73});
  assert.deepEqual(stats(data,{...first,followup_on:'2999-01-01'},survey),{total:22,answered:16,pending:0,waiting:6,percent:73},'antes do prazo do Form 4 ninguém conta como pendente');
  data.enrollments.find(e=>e.student_id===data.students[0].id)!.excluded=true;
  assert.deepEqual(stats(data,first,survey),{total:21,answered:15,pending:6,waiting:0,percent:71});
  const partner=demoDataset('partner');assert.equal(partner.classes.length,2);assert.equal(partner.answers.length,0);
  assert.equal(classStudents(partner,'class-3').length,0);
});
