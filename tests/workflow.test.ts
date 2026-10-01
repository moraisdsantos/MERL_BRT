import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyDataset } from '../src/domain';
import { parseManagement,parseDate,plusDays,brazilToday } from '../src/management';
import { compactURN,matchSubmission,nameScore,normalizeName,prepareForm4,timingFlags } from '../src/matching';
import { parseAttendancePage,type TextAtom } from '../src/attendance-layout';
function fixture(){const d=emptyDataset();d.classes=[{id:'c1',code:'T01',name:'Centro',partner:'',starts_on:'2026-08-03',ends_on:'2026-08-07',followup_on:'2026-08-28',management_imported:true},{id:'c2',code:'T02',name:'Centro',partner:'',starts_on:'2026-08-31',ends_on:'2026-09-04',followup_on:'2026-09-25',management_imported:true}];d.students=[{id:'s1',urn:'L-B10001',name:'Alice Maria de Souza Lima',phone:''},{id:'s2',urn:'L-B10022',name:'Alice Maria de Souza Lima',phone:''},{id:'s3',urn:'L-B10003',name:'Clára Helena Rocha Azevedo',phone:''},{id:'s4',urn:'L-B10004',name:'Bárbara Helena Oliveira',phone:''},{id:'s5',urn:'L-B10005',name:'Daniela Fernanda Campos',phone:''}];d.enrollments=d.students.map((s,i)=>({student_id:s.id,class_id:i===1?'c2':'c1',excluded:false,exclusion_reason:'',attendance_verified:true}));return d;}
test('management CSV ignores empty duplicate headers, guidance, and models; creates dates plus 21 days',()=>{
  const csv='ID,URL Edição,URL Divulgação,ID_Turma,Centro de Treinamento,Turno,Início da Turma,Conclusão da Turma,,,\nMODELO,model,,N/A,,,N/A,N/A,,,\n,Turma 01,Divulgação T01,T01,CENTUR ,Tarde,03/08/2026,07/08/2026,,,\n,Turma 02,,T02,CENTUR,Tarde,31/08/2026,04/09/2026,,,';
  const result=parseManagement(csv);assert.equal(result.errors.length,0);assert.equal(result.rows.length,2);assert.equal(result.rows[0].followup_on,'2026-08-28');assert.equal(result.rows[1].followup_on,'2026-09-25');assert.equal(result.rows[0].url,'');
  assert.equal(parseDate('31/02/2026'),null);assert.equal(plusDays('2026-12-20',21),'2027-01-10');assert.equal(brazilToday(new Date('2026-10-01T01:00:00Z')),'2026-09-30');
  assert.ok(parseManagement('ID_Turma,Início da Turma,Conclusão da Turma\nT01,04/09/2026,31/08/2026').errors.length);
});
test('matching handles whitespace, accents and abbreviated middle names, with conservative ambiguity handling',()=>{
  assert.equal(normalizeName('  Clára  Helena da Rocha '),'CLARA HELENA ROCHA');assert.equal(compactURN(' L- B1-0001 '),'LB10001');assert.equal(nameScore('Alice Souza Lima','Alice Maria de Souza Lima').score,.95);
  const d=fixture();let match=matchSubmission('LB-10001','Alice Maria Souza Lima','', '2026-09-01T12:00:00Z',d);
  assert.equal(match.state,'linked');assert.equal(match.student_id,'s1');
  match=matchSubmission('','Alice Maria Souza Lima','', '2026-09-30T12:00:00Z',d);assert.equal(match.state,'review');assert.ok(match.flags.includes('Mais de uma correspondência'));
  match=matchSubmission('','Clára Rocha Azevedo','', '2026-09-01T12:00:00Z',d);assert.equal(match.state,'linked');assert.ok(match.flags.includes('Nome do meio abreviado'));
  match=matchSubmission('L-N10003','Clára Helena Rocha Azevedo','', '2026-09-01T12:00:00Z',d);assert.equal(match.state,'review');assert.ok(match.flags.includes('Matrícula divergente'));
  d.students[2].urn='L-N10003';match=matchSubmission('L-N10003','Clára Helena Rocha Azevedo','', '2026-09-01T12:00:00Z',d);assert.equal(match.state,'review');assert.ok(match.flags.includes('Código de país na matrícula'));
});
test('an exact URN with a different name never automatically marks a student as responded',()=>{
  const match=matchSubmission('L-B10004','Daniela Fernanda Campos','', '2026-08-07T12:00:00Z',fixture());assert.equal(match.state,'review');assert.ok(match.flags.includes('Matrícula e nome divergentes'));assert.equal(match.student_id,null);
});
test('timing flags use course dates and Brazil calendar dates without discarding early answers',()=>{
  const d=fixture();assert.deepEqual(timingFlags('2026-08-28T01:00:00Z','c1',d),['Resposta antes de 3 semanas']);assert.deepEqual(timingFlags('2026-08-28T13:00:00Z','c1',d),[]);
  const m=matchSubmission('L-B10003','Clára Helena Rocha Azevedo','', '2026-08-07T12:00:00Z',d);assert.equal(m.state,'linked');assert.ok(m.flags.includes('Resposta antes de 3 semanas'));
});
test('real Form 4 header conventions support Brasil/Brazil, duplicates and full answer retention',async()=>{
  const fields={urn:'main_survey/A1_Please_enter_y_stration_Number_URN',name:'main_survey/A2_Please_enter_your_name',country:'main_survey/A3_Country'};
  const row={_uuid:'one',_submission_time:'2026-09-28T12:00:00Z',[fields.urn]:'L-B10003',[fields.name]:'CLARA HELENA ROCHA AZEVEDO',[fields.country]:'1__brasil',question:'all answers'};
  const result=await prepareForm4([row,{...row,_uuid:'other',[fields.country]:'2__indonesia'},row],fixture());assert.equal(result.rows.length,1);assert.equal(result.other,1);assert.equal(result.repeated,1);assert.equal(result.rows[0].answers.question,'all answers');assert.equal(result.linked,1);
});
test('PDF extraction groups by coordinates rather than text-stream ordering',()=>{
  const a=(text:string,x:number,y:number,width=30):TextAtom=>({text,x,y,width,height:10});
  const atoms=[a('Telefone',248,220),a('Idade',299,220),a('L-B10001',28,280),a('L-B10002',28,304),a('Ana',69,280,14),a('Maria da Silva',111,280,70),a('Bruno',69,304),a('Martins',111,304),a('91',236,280,9),a('999999999',246,280,45),a('91988888888',236,304,50),a('50',298,280)];
  const rows=parseAttendancePage(atoms,612,1);assert.equal(rows.length,2);assert.equal(rows[0].name,'Ana Maria da Silva');assert.equal(rows[0].phone,'91999999999');assert.equal(rows[1].name,'Bruno Martins');assert.ok(parseAttendancePage(atoms,612,1,true)[0].attention.includes('Texto reconhecido por OCR'));
});
