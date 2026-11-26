import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

test('Form 3 migration: both surveys per class, per-form completion, issues visibility',async t=>{
  const db=new PGlite();const admin='00000000-0000-0000-0000-000000000021',partner='00000000-0000-0000-0000-000000000022';
  await db.exec(`create role authenticated noinherit;create role anon noinherit;create schema auth;create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}'::jsonb);create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;`);
  for(const file of ['001_sidp.sql','002_form4_workflow.sql','003_ai_and_partner_privacy.sql','004_form3_and_issues.sql'])
    await db.exec(await readFile(new URL(`../supabase/migrations/${file}`,import.meta.url),'utf8'));
  await db.query(`insert into auth.users(id,email) values($1,'admin@example.org'),($2,'partner@example.org')`,[admin,partner]);
  await db.query(`update profiles set role='admin' where id=$1`,[admin]);
  const login=async(id:string)=>{await db.exec('reset role');await db.query(`select set_config('request.jwt.claim.sub',$1,false)`,[id]);await db.exec('set role authenticated');};
  const q=(sql:string,p:unknown[]=[])=>db.query(sql,p);const json=(value:unknown)=>JSON.stringify(value);
  let cid='',otherClass='',student='';
  try{
    await login(admin);
    await t.test('management import provisions F3 and F4 surveys; F3 is due at course end',async()=>{
      await q('select import_management($1::jsonb,$2)',[json([
        {code:'T01',name:'Centro',starts_on:'2026-11-23',ends_on:'2026-11-27',url:'https://example.org/f4'},
        {code:'T02',name:'Outro centro',starts_on:'2026-11-23',ends_on:'2026-11-27',url:''},
      ]),'board.csv']);
      const classes=(await q<{id:string;code:string}>('select id,code from classes order by code')).rows;
      cid=String(classes[0].id);otherClass=String(classes[1].id);
      const surveys=(await q<{code:string;due_date:string}>(`select code,due_date::text from surveys where class_id=$1 order by code`,[cid])).rows;
      assert.deepEqual(surveys.map(s=>s.code),['F3','F4']);
      assert.equal(surveys[0].due_date,'2026-11-27');assert.equal(surveys[1].due_date,'2026-12-18');
    });
    await t.test('a linked Form 3 submission counts toward the F3 survey only, with course timing rules',async()=>{
      await q('select import_attendance($1,$2::jsonb,$3)',[cid,json([{urn:'L-B2-0019',name:'Victor Gabriel',phone:'(91) 99999-9999',attendance_verified:true,attention:[]}]),'freq.pdf']);
      student=String((await q('select id from students')).rows[0].id);
      await q('select import_form_responses($1,$2::jsonb,$3::jsonb,$4)',['F3',json([{external_id:'f3-1',source_urn:'L-B2-0019',source_name:'Victor Gabriel',country:'1__brasil',submitted_at:'2026-11-24T15:00:00Z',student_id:student,class_id:cid,state:'linked',flags:[],candidates:[],answers:{Q:'A'}}]),json([{Q:'A'}]),'form3.csv']);
      const rows=(await q<{code:string}>('select s.code from response_status r join surveys s on s.id=r.survey_id')).rows;
      assert.deepEqual(rows.map(r=>r.code),['F3']);
      const attention=(await q<{attention:string[]}>('select attention from response_status')).rows[0].attention;
      assert.ok(!attention.includes('Resposta antes de 3 semanas'),'o prazo de 3 semanas não vale para o Form 3');
      const kind=(await q<{kind:string}>(`select kind from source_imports order by imported_at desc limit 1`)).rows[0].kind;
      assert.equal(kind,'form3');
    });
    await t.test('the same external_id cannot migrate between forms; Form 4 wrapper still works',async()=>{
      await assert.rejects(()=>q('select import_form_responses($1,$2::jsonb,$3::jsonb,$4)',['F4',json([{external_id:'f3-1',source_urn:'L-B2-0019',source_name:'Victor Gabriel',country:'1__brasil',submitted_at:'2026-12-20T15:00:00Z',student_id:student,class_id:cid,state:'linked',flags:[],candidates:[],answers:{}}]),json([{}]),'x.csv']),/belongs to another form/);
      await q('select import_form4($1::jsonb,$2::jsonb,$3)',[json([{external_id:'f4-1',source_urn:'L-B2-0019',source_name:'Victor Gabriel',country:'1__brasil',submitted_at:'2026-12-20T15:00:00Z',student_id:student,class_id:cid,state:'linked',flags:[],candidates:[],answers:{Q:'B'}}]),json([{Q:'B'}]),'form4.csv']);
      const rows=(await q<{code:string}>('select s.code from response_status r join surveys s on s.id=r.survey_id order by s.code')).rows;
      assert.deepEqual(rows.map(r=>r.code),['F3','F4']);
      assert.equal((await q(`select * from form4_submissions where form_code='F3'`)).rows.length,1);
    });
    await t.test('resolving a review heals the form it belongs to',async()=>{
      await q('select import_form_responses($1,$2::jsonb,$3::jsonb,$4)',['F3',json([{external_id:'f3-2',source_urn:'',source_name:'Victor G.',country:'1__brasil',submitted_at:'2026-11-25T15:00:00Z',student_id:null,class_id:null,state:'review',flags:['Sem correspondência'],candidates:[],answers:{Q:'C'}}]),json([{Q:'C'}]),'form3b.csv']);
      const sub=(await q<{id:string}>(`select id from form4_submissions where external_id='f3-2'`)).rows[0];
      await q('select resolve_form4($1,$2,$3,$4,$5)',[sub.id,student,cid,'linked','Conferido no teste']);
      const f3=(await q<{responded_at:string}>(`select r.responded_at::text from response_status r join surveys s on s.id=r.survey_id where s.code='F3'`)).rows[0];
      assert.match(f3.responded_at,/^2026-11-25/);
      const flags=(await q<{attention:string[]}>(`select attention from response_status r join surveys s on s.id=r.survey_id where s.code='F3'`)).rows[0].attention;
      assert.ok(flags.includes('Respostas duplicadas'));
    });
    await t.test('issues: admin writes, partner reads only issues touching accessible classes',async()=>{
      await q('select set_class_access($1,$2,true)',['partner@example.org',cid]);
      await q('select save_issue(null,$1,$2,$3,$4,$5::uuid[])',['urn','Folhas renumeradas','Folhas impressas reiniciam em 0001','Reimprimir com URNs oficiais',`{${cid}}`]);
      await q('select save_issue(null,$1,$2,$3,$4,$5::uuid[])',['frequencia','Frequência pendente','','Cobrar envio do PDF',`{${otherClass}}`]);
      await q('select save_issue(null,$1,$2,$3,$4,$5::uuid[])',['outra','Nota geral','','','{}']);
      assert.equal((await q('select * from issues')).rows.length,3);
      await login(partner);
      const visible=(await q<{title:string}>('select title from issues order by title')).rows;
      assert.deepEqual(visible.map(v=>v.title),['Folhas renumeradas']);
      await assert.rejects(()=>q('select save_issue(null,$1,$2,$3,$4,$5::uuid[])',['outra','Hack','','','{}']),/Admin access required/);
      await login(admin);
      const id=(await q<{id:string}>(`select id from issues where title='Folhas renumeradas'`)).rows[0].id;
      await q('select set_issue_status($1,$2,$3)',[id,'resolvida','Folhas reimpressas na semana 5']);
      const done=(await q<{status:string;resolution_note:string;resolved_at:string|null}>(`select status,resolution_note,resolved_at::text from issues where id=$1`,[id])).rows[0];
      assert.equal(done.status,'resolvida');assert.equal(done.resolution_note,'Folhas reimpressas na semana 5');assert.ok(done.resolved_at);
    });
  }finally{
    await db.close();
  }
});
