import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
test('Form 4 workflow migration: board → verified attendance → reviewable answers',async t=>{
  const db=new PGlite();const admin='00000000-0000-0000-0000-000000000011',partner='00000000-0000-0000-0000-000000000012';
  await db.exec(`create role authenticated noinherit;create role anon noinherit;create schema auth;create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}'::jsonb);create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;`);
  await db.exec(await readFile(new URL('../supabase/migrations/001_sidp.sql',import.meta.url),'utf8'));
  await db.exec(await readFile(new URL('../supabase/migrations/002_form4_workflow.sql',import.meta.url),'utf8'));
  await db.query(`insert into auth.users(id,email) values($1,'admin@example.org'),($2,'partner@example.org')`,[admin,partner]);await db.query(`update profiles set role='admin' where id=$1`,[admin]);
  const login=async(id:string)=>{await db.exec('reset role');await db.query(`select set_config('request.jwt.claim.sub',$1,false)`,[id]);await db.exec('set role authenticated');};
  const q=(sql:string,p:unknown[]=[])=>db.query(sql,p);const json=(value:unknown)=>JSON.stringify(value);let cid='',student='';
  try{
    await login(admin);
    await t.test('only the management import creates classes; ending plus 21 days is authoritative',async()=>{
      assert.equal((await q('select id from classes')).rows.length,0);
      await q('select import_management($1::jsonb,$2)',[json([{code:'T01',name:'CENTUR',starts_on:'2026-08-03',ends_on:'2026-08-07',followup_on:'2099-01-01',url:''}]),'board.csv']);
      const c=(await q('select id,followup_on::text from classes')).rows[0];cid=String(c.id);assert.equal(c.followup_on,'2026-08-28');assert.equal((await q('select code from surveys')).rows[0].code,'F4');
    });
    await t.test('attendance requires explicit verification and preserves exclusions across reuploads',async()=>{
      await assert.rejects(()=>q('select import_attendance($1,$2::jsonb,$3)',[cid,json([{urn:'L-B10001',name:'Ana Silva'}]),'list.pdf']),/Confirm participant attendance/);
      await q('select import_attendance($1,$2::jsonb,$3)',[cid,json([{urn:'L-B10001',name:'Ana Maria Silva',phone:'',attendance_verified:true,attention:[]}]),'list.pdf']);
      student=String((await q('select id from students')).rows[0].id);await q('select set_class_access($1,$2,true)',['partner@example.org',cid]);
    });
    const submission=(id:string,state='review')=>({external_id:id,source_urn:'L-B10001',source_name:'Ana Silva',country:'1__brasil',submitted_at:'2026-08-07T12:00:00Z',student_id:state==='linked'?student:null,class_id:state==='linked'?cid:null,state,flags:['Nome incompleto'],candidates:[{student_id:student,class_id:cid,score:.84,reason:'Nome incompleto'}],answers:{Q1:'FULL ANSWER'}});
    await t.test('ambiguous answers preserve raw data but do not count as completed; partner cannot inspect raw rows',async()=>{
      await q('select import_form4($1::jsonb,$2::jsonb,$3)',[json([submission('one')]),json([{Q1:'FULL ANSWER',country:'brasil'}]),'form4.csv']);
      assert.equal((await q('select * from response_status')).rows.length,0);assert.equal((await q('select review_pending from enrollments')).rows[0].review_pending,true);
      await login(partner);assert.equal((await q('select * from students')).rows.length,1);assert.equal((await q('select * from form4_submissions')).rows.length,0);assert.equal((await q('select * from source_imports')).rows.length,0);
      await assert.rejects(()=>q('select management_source from classes'),/permission denied/);
      await assert.rejects(()=>q('select import_management($1::jsonb,$2)',[json([]),'board.csv']),/Admin access required/);await login(admin);
    });
    await t.test('manual review creates status, flags an early answer, and survives a conflicting reimport',async()=>{
      const id=String((await q('select id from form4_submissions')).rows[0].id);
      await q('select resolve_form4($1,$2,$3,$4,$5)',[id,student,cid,'linked','Identity checked']);
      assert.equal((await q('select * from response_status')).rows.length,1);assert.ok(((await q('select attention from response_status')).rows[0].attention as string[]).includes('Resposta antes de 3 semanas'));
      assert.equal((await q('select answers from response_answers')).rows[0].answers?.['Q1'],'FULL ANSWER');
      await q('select import_form4($1::jsonb,$2::jsonb,$3)',[json([submission('one')]),json([]),'form4.csv']);assert.equal((await q('select state,match_origin from form4_submissions')).rows[0].state,'linked');
      await q('select resolve_form4($1,null,null,$2,$3)',[id,'ignored','Not a valid record']);assert.equal((await q('select * from response_status')).rows.length,0);assert.equal((await q('select * from form4_submissions')).rows.length,1);
    });
    await t.test('duplicates count once; latest answer wins; exclusion still blocks partner access',async()=>{
      await q('select import_form4($1::jsonb,$2::jsonb,$3)',[json([submission('two','linked'),{...submission('three','linked'),submitted_at:'2026-09-28T12:00:00Z',answers:{Q1:'LATEST'}}]),json([]),'form4.csv']);
      assert.equal((await q('select * from response_status')).rows.length,1);assert.equal((await q('select answers from response_answers')).rows[0].answers?.['Q1'],'LATEST');assert.ok(((await q('select attention from response_status')).rows[0].attention as string[]).includes('Respostas duplicadas'));
      await q('select set_exclusion($1,$2,true,$3)',[student,cid,'Withdrawn']);await q('select import_attendance($1,$2::jsonb,$3)',[cid,json([{urn:'L-B10001',name:'Ana Maria Silva',attendance_verified:true}]),'list.pdf']);
      assert.equal((await q('select excluded from enrollments')).rows[0].excluded,true);await login(partner);assert.equal((await q('select * from students')).rows.length,0);assert.equal((await q('select * from response_status')).rows.length,0);
    });
  }finally{await db.close();}
});
test('v1 upgrade copies complete F4 answers to review records before replacing completion headers',async()=>{
  const db=new PGlite();try{
    await db.exec(`create role authenticated;create role anon;create schema auth;create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}');create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;`);
    await db.exec(await readFile(new URL('../supabase/migrations/001_sidp.sql',import.meta.url),'utf8'));
    await db.exec(`insert into classes(code,name) values('T01','Legacy');insert into surveys(class_id,code,name,message_template) select id,'F4','Form 4','Message' from classes;insert into students(urn,name) values('L-B10001','Example Learner');insert into enrollments(student_id,class_id) select s.id,c.id from students s cross join classes c;insert into response_status(student_id,class_id,survey_id) select st.id,c.id,s.id from students st cross join classes c join surveys s on s.class_id=c.id;insert into response_answers(response_id,answers) select id,'{"Q1":"COMPLETE LEGACY ANSWER"}'::jsonb from response_status;`);
    await db.exec(await readFile(new URL('../supabase/migrations/002_form4_workflow.sql',import.meta.url),'utf8'));
    const rows=(await db.query('select state,source_name,answers from form4_submissions')).rows;assert.equal(rows.length,1);assert.equal(rows[0].state,'review');assert.equal(rows[0].source_name,'Example Learner');assert.deepEqual(rows[0].answers,{Q1:'COMPLETE LEGACY ANSWER'});assert.equal((await db.query('select * from response_status')).rows.length,0);assert.equal((await db.query('select * from students')).rows.length,1);
  }finally{await db.close();}
});
