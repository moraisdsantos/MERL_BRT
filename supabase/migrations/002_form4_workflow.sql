-- Apply after 001_sidp.sql. Preserves existing users, classes, and answers.
begin;
alter table public.classes add column starts_on date,add column ends_on date,add column followup_on date,
  add column shift text not null default '',add column management_imported boolean not null default false,
  add column management_source jsonb not null default '{}';
alter table public.classes add constraint class_dates_check check(ends_on is null or starts_on is null or ends_on>=starts_on);
-- The original board may contain administrative edit URLs. Do not expose its JSON
-- through the class table, even for a partner who can read that class's panel.
revoke select on public.classes from authenticated;
grant select(id,code,name,partner,starts_on,ends_on,followup_on,shift,management_imported) on public.classes to authenticated;
alter table public.enrollments add column attendance_verified boolean not null default false,
  add column attention text[] not null default '{}',add column review_pending boolean not null default false;
alter table public.response_status add column attention text[] not null default '{}';
create or replace function private.can_read_student(p_student uuid) returns boolean language sql stable security definer set search_path='' as $$
  select private.is_admin() or exists(select 1 from public.enrollments e join public.class_access a on a.class_id=e.class_id where a.user_id=(select auth.uid()) and e.student_id=p_student and not e.excluded and e.attendance_verified);
$$;
drop policy enrollments_read on public.enrollments;
create policy enrollments_read on public.enrollments for select to authenticated using(private.is_admin() or (not excluded and attendance_verified and private.can_access(class_id)));
create table public.source_imports(
  id uuid primary key default gen_random_uuid(),kind text not null check(kind in ('management','attendance','form4')),
  filename text not null,imported_by uuid not null references public.profiles(id),imported_at timestamptz not null default now(),
  row_count integer not null,metadata jsonb not null default '{}',payload jsonb not null
);
create table public.form4_submissions(
  id uuid primary key default gen_random_uuid(),external_id text not null unique,
  source_urn text not null default '',source_name text not null default '',source_phone text not null default '',country text not null default '',
  submitted_at timestamptz,student_id uuid references public.students(id),class_id uuid references public.classes(id),
  state text not null check(state in ('linked','review','ignored')),flags text[] not null default '{}',
  candidates jsonb not null default '[]',answers jsonb not null,match_origin text not null default 'auto' check(match_origin in ('auto','manual')),
  review_reason text not null default '',updated_at timestamptz not null default now(),
  check((state='linked' and student_id is not null and class_id is not null and submitted_at is not null) or (state<>'linked' and student_id is null and class_id is null))
);
create index form4_match_idx on public.form4_submissions(student_id,class_id);
create index form4_state_idx on public.form4_submissions(state);
-- Keep v1 F4 answers as reviewable records. Their old completion headers are rebuilt
-- only after the new attendance / reconciliation workflow confirms their identity.
insert into public.form4_submissions(external_id,source_urn,source_name,country,submitted_at,state,flags,candidates,answers)
select 'legacy-'||r.id::text,
  coalesce(a.answers->>'main_survey/A1_Please_enter_y_stration_Number_URN',st.urn),
  coalesce(a.answers->>'main_survey/A2_Please_enter_your_name',st.name),
  coalesce(a.answers->>'main_survey/A3_Country','brasil'),r.responded_at,'review',array['Conferir vínculo da versão anterior'],
  jsonb_build_array(jsonb_build_object('student_id',r.student_id,'class_id',r.class_id,'score',1,'reason','Vínculo anterior')),
  coalesce(a.answers,jsonb_build_object('matricula',st.urn,'nome',st.name,'pais','brasil','submitted_at',r.responded_at))
from public.response_status r join public.surveys s on s.id=r.survey_id join public.students st on st.id=r.student_id
left join public.response_answers a on a.response_id=r.id where s.code='F4';
delete from public.response_status r using public.surveys s where s.id=r.survey_id and s.code='F4';
alter table public.source_imports enable row level security;
alter table public.form4_submissions enable row level security;
create policy source_admin on public.source_imports for select to authenticated using(private.is_admin());
create policy form4_admin on public.form4_submissions for select to authenticated using(private.is_admin());
grant select on public.source_imports,public.form4_submissions to authenticated;
revoke all on public.source_imports,public.form4_submissions from anon;

create function private.form4_flags(p_date timestamptz,p_class uuid) returns text[] language sql stable security definer set search_path='' as $$
  select case when p_date is null then array['Data da resposta ausente']::text[]
    when (p_date at time zone 'America/Sao_Paulo')::date<c.starts_on then array['Resposta anterior à turma']::text[]
    when (p_date at time zone 'America/Sao_Paulo')::date<c.followup_on then array['Resposta antes de 3 semanas']::text[] else '{}'::text[] end
  from public.classes c where id=p_class;
$$;
create function private.refresh_review_flags() returns void language plpgsql security definer set search_path='' as $$
begin
  update public.enrollments e set review_pending=exists(
    select 1 from public.form4_submissions f cross join lateral jsonb_array_elements(f.candidates) candidate
    where f.state='review' and candidate->>'student_id'=e.student_id::text and candidate->>'class_id'=e.class_id::text
  );
end;
$$;
create function private.refresh_form4(p_student uuid,p_class uuid) returns void language plpgsql security definer set search_path='' as $$
declare latest public.form4_submissions;sid uuid;rid uuid;combined text[];n integer;
begin
  select id into sid from public.surveys where class_id=p_class and code='F4';if sid is null then return;end if;
  select * into latest from public.form4_submissions where student_id=p_student and class_id=p_class and state='linked' order by submitted_at desc,id desc limit 1;
  if not found then delete from public.response_status where student_id=p_student and survey_id=sid;return;end if;
  select count(*) into n from public.form4_submissions where student_id=p_student and class_id=p_class and state='linked';
  select coalesce(array_agg(distinct flag),'{}') into combined from unnest(
    array(select x from unnest(latest.flags) x where x not in ('Resposta antes de 3 semanas','Resposta anterior à turma','Respostas duplicadas'))
    || coalesce(private.form4_flags(latest.submitted_at,p_class),'{}') || case when n>1 then array['Respostas duplicadas'] else '{}'::text[] end
  ) flag;
  insert into public.response_status(class_id,survey_id,student_id,responded_at,attention) values(p_class,sid,p_student,latest.submitted_at,combined)
  on conflict(survey_id,student_id) do update set responded_at=excluded.responded_at,attention=excluded.attention returning id into rid;
  insert into public.response_answers(response_id,answers) values(rid,latest.answers) on conflict(response_id) do update set answers=excluded.answers;
end;
$$;

create function public.import_management(p_rows jsonb,p_filename text) returns integer language plpgsql security definer set search_path='' as $$
declare r jsonb;cid uuid;n integer:=0;start_date date;end_date date;
begin
  if not private.is_admin() then raise exception 'Admin access required' using errcode='42501';end if;
  if jsonb_typeof(p_rows)<>'array' or jsonb_array_length(p_rows) not between 1 and 1000 then raise exception 'Invalid class dataset';end if;
  for r in select value from jsonb_array_elements(p_rows) loop
    if coalesce(r->>'code','') !~ '^T[0-9]{2,4}$' then raise exception 'Invalid class code';end if;
    start_date:=(r->>'starts_on')::date;end_date:=(r->>'ends_on')::date;
    if start_date is null or end_date is null or end_date<start_date then raise exception 'Invalid class dates';end if;
    insert into public.classes(code,name,partner,starts_on,ends_on,followup_on,shift,management_imported,management_source)
    values(r->>'code',coalesce(nullif(r->>'name',''),r->>'code'),'',start_date,end_date,end_date+21,coalesce(r->>'shift',''),true,coalesce(r->'source','{}'))
    on conflict(code) do update set name=excluded.name,starts_on=excluded.starts_on,ends_on=excluded.ends_on,followup_on=excluded.followup_on,shift=excluded.shift,management_imported=true,management_source=excluded.management_source returning id into cid;
    insert into public.surveys(class_id,code,name,url,due_date,message_template)
    values(cid,'F4','Form 4',case when r->>'url' ~ '^https://' then r->>'url' else '' end,end_date+21,E'Olá, {nome}! Aqui é a equipe SIDP — British Council, Fase V. Sua turma {turma} encerrou há três semanas. Você pode responder ao Form 4 pelo link: {link}\n\nMatrícula: {matricula}\nObrigado!\nEquipe MERL · ARCA')
    on conflict(class_id,code) do update set due_date=excluded.due_date,url=coalesce(nullif(excluded.url,''),public.surveys.url);
    n:=n+1;
    -- Re-evaluate the timing flags when the board changes course dates.
    perform private.refresh_form4(f.student_id,cid) from (select distinct student_id from public.form4_submissions where class_id=cid and state='linked') f;
  end loop;
  insert into public.source_imports(kind,filename,imported_by,row_count,payload) values('management',p_filename,auth.uid(),n,p_rows);
  return n;
end;
$$;
create function public.import_attendance(p_class_id uuid,p_rows jsonb,p_filename text) returns integer language plpgsql security definer set search_path='' as $$
declare r jsonb;sid uuid;n integer:=0;urn_value text;flags text[];
begin
  if not private.is_admin() then raise exception 'Admin access required' using errcode='42501';end if;
  if not exists(select 1 from public.classes where id=p_class_id and management_imported) then raise exception 'Import the management board first';end if;
  if jsonb_typeof(p_rows)<>'array' or jsonb_array_length(p_rows) not between 1 and 5000 then raise exception 'Invalid attendance dataset';end if;
  if (select count(*) from jsonb_array_elements(p_rows))<>(select count(distinct upper(trim(x->>'urn'))) from jsonb_array_elements(p_rows) x) then raise exception 'Duplicate attendance URNs';end if;
  for r in select value from jsonb_array_elements(p_rows) loop
    urn_value:=upper(trim(r->>'urn'));if urn_value is null or urn_value='' or urn_value ~ '\s' or coalesce(trim(r->>'name'),'')='' then raise exception 'Check name and URN';end if;
    if coalesce((r->>'attendance_verified')::boolean,false) is not true then raise exception 'Confirm participant attendance';end if;
    insert into public.students(urn,name,phone) values(urn_value,trim(r->>'name'),coalesce(r->>'phone',''))
    on conflict(urn) do update set name=excluded.name,phone=coalesce(nullif(excluded.phone,''),public.students.phone) returning id into sid;
    select coalesce(array_agg(v),'{}') into flags from jsonb_array_elements_text(coalesce(r->'attention','[]')) v;
    insert into public.enrollments(student_id,class_id,attendance_verified,attention) values(sid,p_class_id,true,flags)
    on conflict(student_id,class_id) do update set attendance_verified=true,attention=excluded.attention;
    n:=n+1;
  end loop;
  insert into public.source_imports(kind,filename,imported_by,row_count,metadata,payload) values('attendance',p_filename,auth.uid(),n,jsonb_build_object('class_id',p_class_id),p_rows);
  perform private.refresh_review_flags();return n;
end;
$$;
create function public.import_form4(p_rows jsonb,p_source jsonb,p_filename text) returns integer language plpgsql security definer set search_path='' as $$
declare r jsonb;prior public.form4_submissions;sid uuid;cid uuid;current_state text;origin text;flags text[];old_sid uuid;old_cid uuid;n integer:=0;
begin
  if not private.is_admin() then raise exception 'Admin access required' using errcode='42501';end if;
  if jsonb_typeof(p_rows)<>'array' or jsonb_array_length(p_rows)>5000 or jsonb_typeof(p_source)<>'array' or jsonb_array_length(p_source)>5000 then raise exception 'Invalid Form 4 dataset';end if;
  for r in select value from jsonb_array_elements(p_rows) loop
    select * into prior from public.form4_submissions where external_id=r->>'external_id';old_sid:=prior.student_id;old_cid:=prior.class_id;
    sid:=nullif(r->>'student_id','')::uuid;cid:=nullif(r->>'class_id','')::uuid;current_state:=r->>'state';origin:='auto';
    select coalesce(array_agg(v),'{}') into flags from jsonb_array_elements_text(coalesce(r->'flags','[]')) v;
    -- A reimport cannot undo an explicitly reviewed match, even with a stale client.
    if prior.match_origin='manual' then sid:=prior.student_id;cid:=prior.class_id;current_state:=prior.state;origin:='manual';
      if prior.source_urn<>coalesce(r->>'source_urn','') or prior.source_name<>coalesce(r->>'source_name','') then flags:=flags||array['Identificação alterada na origem'];end if;
    end if;
    if current_state='linked' and not exists(select 1 from public.enrollments where student_id=sid and class_id=cid and not excluded and attendance_verified) then current_state:='review';sid:=null;cid:=null;flags:=flags||array['Presença não confirmada'];end if;
    insert into public.form4_submissions(external_id,source_urn,source_name,source_phone,country,submitted_at,student_id,class_id,state,flags,candidates,answers,match_origin,review_reason)
    values(r->>'external_id',coalesce(r->>'source_urn',''),coalesce(r->>'source_name',''),coalesce(r->>'source_phone',''),coalesce(r->>'country',''),nullif(r->>'submitted_at','')::timestamptz,sid,cid,current_state,flags,coalesce(r->'candidates','[]'),r->'answers',origin,coalesce(prior.review_reason,''))
    on conflict(external_id) do update set source_urn=excluded.source_urn,source_name=excluded.source_name,source_phone=excluded.source_phone,country=excluded.country,submitted_at=excluded.submitted_at,student_id=excluded.student_id,class_id=excluded.class_id,state=excluded.state,flags=excluded.flags,candidates=excluded.candidates,answers=excluded.answers,match_origin=excluded.match_origin,updated_at=now();
    if old_sid is not null then perform private.refresh_form4(old_sid,old_cid);end if;
    n:=n+1;
  end loop;
  perform private.refresh_form4(pair.student_id,pair.class_id) from (select distinct student_id,class_id from public.form4_submissions where state='linked') pair;
  perform private.refresh_review_flags();
  insert into public.source_imports(kind,filename,imported_by,row_count,metadata,payload) values('form4',p_filename,auth.uid(),jsonb_array_length(p_source),jsonb_build_object('considered',n),p_source);
  return n;
end;
$$;
create function public.resolve_form4(p_id uuid,p_student_id uuid,p_class_id uuid,p_state text,p_reason text) returns void language plpgsql security definer set search_path='' as $$
declare prior public.form4_submissions;
begin
  if not private.is_admin() then raise exception 'Admin access required' using errcode='42501';end if;
  select * into prior from public.form4_submissions where id=p_id;if not found then raise exception 'Submission not found';end if;
  if p_state not in ('linked','review','ignored') then raise exception 'Invalid resolution';end if;
  if trim(coalesce(p_reason,''))='' then raise exception 'Record a review reason';end if;
  if p_state='linked' and (prior.submitted_at is null or not exists(select 1 from public.enrollments where student_id=p_student_id and class_id=p_class_id and not excluded and attendance_verified)) then raise exception 'Check response date and participant attendance';end if;
  update public.form4_submissions set state=p_state,student_id=case when p_state='linked' then p_student_id else null end,class_id=case when p_state='linked' then p_class_id else null end,match_origin='manual',review_reason=trim(p_reason),updated_at=now(),flags=array(select x from unnest(flags) x where x not in ('Sem correspondência','Mais de uma correspondência','Conferir correspondência')) where id=p_id;
  if prior.student_id is not null then perform private.refresh_form4(prior.student_id,prior.class_id);end if;
  if p_state='linked' then perform private.refresh_form4(p_student_id,p_class_id);end if;
  perform private.refresh_review_flags();
end;
$$;
create or replace function public.save_student_details(p_student_id uuid,p_class_id uuid,p_to_class uuid,p_name text,p_phone text,p_excluded boolean,p_reason text) returns void language plpgsql security definer set search_path='' as $$
begin
  if not private.is_admin() then raise exception 'Admin access required' using errcode='42501';end if;
  perform public.update_student(p_student_id,p_name,p_phone);perform public.set_exclusion(p_student_id,p_class_id,p_excluded,p_reason);
  perform public.move_student(p_student_id,p_class_id,p_to_class);
  if p_to_class<>p_class_id then update public.form4_submissions set class_id=p_to_class,updated_at=now() where student_id=p_student_id and class_id=p_class_id and state='linked';end if;
  if exists(select 1 from public.form4_submissions where student_id=p_student_id and class_id=p_to_class) then perform private.refresh_form4(p_student_id,p_to_class);end if;
  perform private.refresh_review_flags();
end;
$$;
create function public.save_participant(p_student_id uuid,p_class_id uuid,p_to_class uuid,p_urn text,p_name text,p_phone text,p_excluded boolean,p_reason text) returns void language plpgsql security definer set search_path='' as $$
begin
  if not private.is_admin() then raise exception 'Admin access required' using errcode='42501';end if;
  if not exists(select 1 from public.classes where id=p_to_class and management_imported) then raise exception 'Select an imported class';end if;
  if nullif(trim(p_urn),'') is not null then update public.students set urn=upper(trim(p_urn)) where id=p_student_id;end if;
  perform public.save_student_details(p_student_id,p_class_id,p_to_class,p_name,p_phone,p_excluded,p_reason);
  update public.enrollments set attention=case when (select urn from public.students where id=p_student_id) like 'SEM-%' then array['Matrícula ausente'] else '{}'::text[] end where student_id=p_student_id and class_id=p_to_class;
end;
$$;
revoke all on function private.form4_flags(timestamptz,uuid),private.refresh_review_flags(),private.refresh_form4(uuid,uuid),public.import_management(jsonb,text),public.import_attendance(uuid,jsonb,text),public.import_form4(jsonb,jsonb,text),public.resolve_form4(uuid,uuid,uuid,text,text),public.save_participant(uuid,uuid,uuid,text,text,text,boolean,text) from public;
grant execute on function public.import_management(jsonb,text),public.import_attendance(uuid,jsonb,text),public.import_form4(jsonb,jsonb,text),public.resolve_form4(uuid,uuid,uuid,text,text) to authenticated;
grant execute on function public.save_participant(uuid,uuid,uuid,text,text,text,boolean,text) to authenticated;
commit;
