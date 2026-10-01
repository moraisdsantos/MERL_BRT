import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

test('Supabase migration: class isolation, admin operations, atomic imports, and retained answers',async t=>{
  const db=new PGlite();
  const admin='00000000-0000-0000-0000-000000000001';const partner='00000000-0000-0000-0000-000000000002';
  await db.exec(`create role authenticated noinherit;create role anon noinherit;create schema auth;
    create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}'::jsonb);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;`);
  await db.exec(await readFile(new URL('../supabase/migrations/001_sidp.sql',import.meta.url),'utf8'));
  await db.query(`insert into auth.users(id,email,raw_user_meta_data) values($1,'admin@example.org','{}'),($2,'partner@example.org','{"role":"admin"}')`,[admin,partner]);
  await db.query(`update public.profiles set role='admin' where id=$1`,[admin]);
  await db.exec("insert into classes(code,name) values('T01','Centro'),('T02','Centro');insert into surveys(class_id,code,name,message_template) select id,'F4','Form 4','Message' from classes;");
  const classes=(await db.query<{id:string;code:string}>(`select id,code from classes order by code`)).rows;
  const surveys=(await db.query<{id:string;class_id:string}>(`select id,class_id from surveys`)).rows;
  const c1=classes[0].id,c2=classes[1].id;const f1=surveys.find(s=>s.class_id===c1)!.id,f2=surveys.find(s=>s.class_id===c2)!.id;
  const login=async(id:string)=>{await db.exec('reset role');await db.query(`select set_config('request.jwt.claim.sub',$1,false)`,[id]);await db.exec('set role authenticated');};
  const query=(sql:string,params:unknown[]=[])=>db.query(sql,params);
  const imported=(c:string,s:string,kind:string,rows:unknown[])=>query(`select public.import_dataset($1,$2,$3,$4::jsonb,'test.csv')`,[c,s,kind,JSON.stringify(rows)]);
  const row=(urn:string,name:string,responded=false,answers={answer:'stored'},submitted_at:string|null=null)=>({urn,name,phone:'',responded,answers,submitted_at});
  let studentId='';
  try{
    await t.test('user metadata cannot grant admin; unauthenticated accounts see no data',async()=>{
      const p=await query(`select role from profiles where id=$1`,[partner]);assert.equal(p.rows[0].role,'partner');
      await db.exec('set role anon');await assert.rejects(()=>query('select * from classes'),/permission denied/);await db.exec('reset role');
    });
    await t.test('imports preserve full answers and never create duplicate responses or erase completed status',async()=>{
      await login(admin);
      await imported(c1,f1,'roster',[row('L-B1-0001','Maria'),row('L-B1-0002','João')]);
      await imported(c2,f2,'roster',[row('L-B2-0001','Other class')]);
      await imported(c1,f1,'responses',[row('L-B1-0001','Maria',true,{Q1:'real answer',Q2:{score:5}},'2026-09-28T13:00:00Z')]);
      await imported(c1,f1,'responses',[row('L-B1-0001','Maria',true,{Q1:'older answer'},'2026-09-27T13:00:00Z')]);
      await imported(c1,f1,'roster',[row('L-B1-0001','Maria',false)]);
      await imported(c1,f1,'roster',[row('L-B1-0001','Maria',true,{roster:'metadata'})]);
      assert.equal((await query('select * from response_status')).rows.length,1);
      const answers=(await query('select answers from response_answers')).rows[0].answers as Record<string,unknown>;
      assert.equal(answers.Q1,'real answer');assert.deepEqual(answers.Q2,{score:5});
      studentId=String((await query(`select id from students where urn='L-B1-0001'`)).rows[0].id);
      await query('select public.set_class_access($1,$2,true)',['partner@example.org',c1]);
    });
    await t.test('partner sees assigned class only and cannot read full answers or change roles/data',async()=>{
      await login(partner);assert.equal((await query('select * from classes')).rows.length,1);
      assert.equal((await query('select * from students')).rows.length,2);
      assert.equal((await query('select * from response_status')).rows.length,1);
      assert.equal((await query('select * from response_answers')).rows.length,0);
      assert.equal((await query('select * from import_batches')).rows.length,0);
      await assert.rejects(()=>imported(c1,f1,'roster',[row('NEW','Should fail')]),/Admin access required/);
      await assert.rejects(()=>query(`update profiles set role='admin' where id=$1`,[partner]),/permission denied/);
      const result=await query(`update surveys set name='hacked' returning id`);assert.equal(result.rows.length,0);
      await assert.rejects(()=>query(`select public.set_class_access('partner@example.org',$1,true)`,[c2]),/Admin access required/);
    });
    await t.test('invalid imports roll back all rows; roster/class mismatch and duplicate URNs are rejected',async()=>{
      await login(admin);
      await assert.rejects(()=>imported(c1,f1,'roster',[row('TEMP','Should roll back'),row('BAD NAME','Invalid URN')]),/Invalid URN/);
      assert.equal((await query(`select id from students where urn='TEMP'`)).rows.length,0);
      await assert.rejects(()=>imported(c1,f1,'responses',[row('UNKNOWN','Unknown')]),/not enrolled/);
      assert.equal((await query(`select id from students where urn='UNKNOWN'`)).rows.length,0);
      await assert.rejects(()=>imported(c1,f2,'roster',[row('MISMATCH','Fail')]),/mismatch/);
      await assert.rejects(()=>imported(c1,f1,'roster',[row('DUP','One'),row('DUP','Two')]),/Duplicate/);
    });
    await t.test('exclusion hides student and status from partners but retains answers and survives reimports',async()=>{
      await login(admin);await query(`select public.set_exclusion($1,$2,true,'Withdrawn')`,[studentId,c1]);
      await imported(c1,f1,'roster',[row('L-B1-0001','Maria')]);
      assert.equal((await query('select * from response_answers')).rows.length,1);
      await login(partner);assert.equal((await query('select * from students')).rows.length,1);assert.equal((await query('select * from response_status')).rows.length,0);
    });
    await t.test('combined edit is atomic; moves retain answers and revocation removes access',async()=>{
      await login(admin);
      await assert.rejects(()=>query(`select public.save_student_details($1,$2,$3,'Changed','',true,'')`,[studentId,c1,c2]),/exclusion reason/);
      assert.equal((await query('select name from students where id=$1',[studentId])).rows[0].name,'Maria');
      await query(`select public.save_student_details($1,$2,$3,'Maria Updated','',false,'')`,[studentId,c1,c2]);
      const status=(await query('select class_id,survey_id from response_status')).rows[0];assert.equal(status.class_id,c2);assert.equal(status.survey_id,f2);
      assert.equal((await query('select * from response_answers')).rows.length,1);
      await query(`select public.set_class_access('partner@example.org',$1,false)`,[c1]);
      await login(partner);assert.equal((await query('select * from classes')).rows.length,0);assert.equal((await query('select * from students')).rows.length,0);
    });
  }finally{await db.close();}
});
