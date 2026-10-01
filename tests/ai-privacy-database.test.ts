import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';

test('v3 protects names at database level and keeps AI separate from official responses',async t=>{
  const db=new PGlite();const admin='00000000-0000-0000-0000-000000000011',partner='00000000-0000-0000-0000-000000000012',otherAdmin='00000000-0000-0000-0000-000000000013';
  const q=(sql:string,p:unknown[]=[])=>db.query(sql,p);const json=JSON.stringify;
  const login=async(id:string)=>{await db.exec('reset role');await q(`select set_config('request.jwt.claim.sub',$1,false)`,[id]);await db.exec('set role authenticated');};
  let cid='',cid2='',student='',run='';
  try{
    await db.exec(`create role authenticated noinherit;create role anon noinherit;create schema auth;create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}'::jsonb);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;`);
    for(const name of ['001_sidp.sql','002_form4_workflow.sql','003_ai_and_partner_privacy.sql'])await db.exec(await readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8'));
    await q(`insert into auth.users(id,email) values($1,'admin@example.org'),($2,'partner@example.org'),($3,'secondadmin@example.org')`,[admin,partner,otherAdmin]);
    await q(`update profiles set role='admin' where id in ($1,$2)`,[admin,otherAdmin]);await login(admin);
    await q('select import_management($1::jsonb,$2)',[json([{code:'T01',name:'Centro Um',starts_on:'2026-08-03',ends_on:'2026-08-07',url:''},{code:'T02',name:'Centro Dois',starts_on:'2026-08-31',ends_on:'2026-09-04',url:''}]),'board.csv']);
    cid=String((await q(`select id from classes where code='T01'`)).rows[0].id);cid2=String((await q(`select id from classes where code='T02'`)).rows[0].id);
    await t.test('analysis requires confirmed attendance and an imported Form 4 source',async()=>{
      await assert.rejects(()=>q('select begin_ai_analysis($1)',[cid]),/confirme a lista/);
      await q('select import_attendance($1,$2::jsonb,$3)',[cid,json([{urn:'L-B10001',name:'Ana Maria Silva',phone:'91999990000',attendance_verified:true,attention:[]}]),'list.pdf']);
      await q('select import_attendance($1,$2::jsonb,$3)',[cid2,json([{urn:'L-B10002',name:'Beatriz Santos',phone:'91999991111',attendance_verified:true,attention:[]}]),'list2.pdf']);
      student=String((await q(`select id from students where urn='L-B10001'`)).rows[0].id);
      await assert.rejects(()=>q('select begin_ai_analysis($1)',[cid]),/dataset do Form 4/);
      await q('select import_form4($1::jsonb,$2::jsonb,$3)',[json([{external_id:'one',source_urn:'L-B10001',source_name:'Ana Silva',country:'1__brasil',submitted_at:'2026-08-29T12:00:00Z',state:'review',flags:['Nome incompleto'],candidates:[{student_id:student,class_id:cid,score:.84,reason:'Nome incompleto'}],answers:{Q1:'PRIVATE ANSWER',phone:'PRIVATE PHONE',edit_url:'PRIVATE EDIT URL'}}]),json([{Q1:'PRIVATE RAW ANSWER'}]),'form4.csv']);
      await q('select set_class_access($1,$2,true)',['partner@example.org',cid]);
    });
    await t.test('partners cannot select names or filter names; safe roster has only assigned URN and phone',async()=>{
      await login(partner);assert.equal((await q('select * from students')).rows.length,0);assert.equal((await q(`select id from students where name like 'Ana%'`)).rows.length,0);
      const roster=(await q('select * from get_partner_students()')).rows;assert.equal(roster.length,1);assert.deepEqual(Object.keys(roster[0]).sort(),['id','phone','urn']);assert.equal(roster[0].urn,'L-B10001');
      assert.equal((await q('select id from classes')).rows.length,1);assert.equal((await q('select * from form4_submissions')).rows.length,0);assert.equal((await q('select * from source_imports')).rows.length,0);assert.equal((await q('select * from response_answers')).rows.length,0);
      for(const sql of ['select begin_ai_analysis($1)','select latest_ai_analysis($1)'])await assert.rejects(()=>q(sql,[cid]),/Admin access required/);
      await assert.rejects(()=>q('select private.ai_snapshot($1)',[cid]),/permission denied/);await login(admin);assert.equal((await q('select name from students')).rows.length,2);
    });
    await t.test('removing access or excluding a student removes the safe roster row immediately',async()=>{
      await q('select set_class_access($1,$2,false)',['partner@example.org',cid]);await login(partner);assert.equal((await q('select * from get_partner_students()')).rows.length,0);
      await login(admin);await q('select set_class_access($1,$2,true)',['partner@example.org',cid]);await q('select set_exclusion($1,$2,true,$3)',[student,cid,'Withdrawn']);await login(partner);assert.equal((await q('select * from get_partner_students()')).rows.length,0);
      await login(admin);await q('select set_exclusion($1,$2,false,$3)',[student,cid,'']);
    });
    await t.test('AI snapshot omits phones, survey answers and raw imports; concurrent class runs are blocked',async()=>{
      const started=(await q('select begin_ai_analysis($1) as result',[cid])).rows[0].result as any;run=started.run_id;
      assert.equal(started.snapshot.participants[0].name,'Ana Maria Silva');assert.equal(started.snapshot.class.followup_on,'2026-08-28');assert.equal(started.snapshot.classes.length,2);assert.equal(started.snapshot.submissions[0].name,'Ana Silva');
      const encoded=json(started.snapshot);for(const secret of ['PRIVATE','91999990000','answers','raw_rows','phone','candidates'])assert.ok(!encoded.includes(secret),secret);
      await assert.rejects(()=>q('select begin_ai_analysis($1)',[cid]),/em andamento/);await login(otherAdmin);await assert.rejects(()=>q('select finish_ai_analysis($1,$2::jsonb,$3,$4)',[run,json({}), 'test','']),/esta conta/);await login(admin);
      assert.equal((await q('select * from response_status')).rows.length,0);
    });
    await t.test('AI results are private, stay current only while inputs match and never create a response',async()=>{
      await q('select finish_ai_analysis($1,$2::jsonb,$3,$4)',[run,json({advice:{summary:'Confira Ana Silva',matches:[],findings:[]}}),'test-model','']);
      let latest=(await q('select latest_ai_analysis($1) as result',[cid])).rows[0].result as any;assert.equal(latest.is_current,true);assert.equal(latest.status,'completed');assert.equal((await q('select * from response_status')).rows.length,0);assert.equal((await q('select state from form4_submissions')).rows[0].state,'review');
      await q('select update_student($1,$2,$3)',[student,'Ana M Silva','91999990000']);latest=(await q('select latest_ai_analysis($1) as result',[cid])).rows[0].result as any;assert.equal(latest.is_current,false);
      await login(partner);assert.equal((await q('select * from ai_analyses')).rows.length,0);await assert.rejects(()=>q('select finish_ai_analysis($1,null,$2,$3)',[run,'test','bad']),/Admin access required/);
      await db.exec('reset role;set role anon');await assert.rejects(()=>q('select * from get_partner_students()'),/permission denied/);await assert.rejects(()=>q('select latest_ai_analysis($1)',[cid]),/permission denied/);
      await login(admin);
    });
    await t.test('administrative hourly reservation limit applies before another provider call',async()=>{
      for(let i=0;i<9;i++){const started=(await q('select begin_ai_analysis($1) as result',[cid])).rows[0].result as any;await q('select finish_ai_analysis($1,null,$2,$3)',[started.run_id,'test','test failure']);}
      await assert.rejects(()=>q('select begin_ai_analysis($1)',[cid]),/Limite de análises/);
    });
  }finally{await db.close();}
});
