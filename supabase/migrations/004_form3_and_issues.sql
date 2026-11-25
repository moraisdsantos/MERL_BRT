-- v4: Form 3 alongside Form 4, and the issues board.
-- Apply after 003_ai_and_partner_privacy.sql. Preserves users, classes, answers and links.
begin;

-- Submissions carry the form they answer. Existing rows are Form 4.
alter table public.form4_submissions add column form_code text not null default 'F4' check(form_code in ('F3','F4'));
create index form4_form_code_idx on public.form4_submissions(form_code);
alter table public.source_imports drop constraint source_imports_kind_check;
alter table public.source_imports add constraint source_imports_kind_check check(kind in ('management','attendance','form4','form3'));

-- Timing rules differ by form: Form 3 runs during the course, Form 4 three weeks after.
create function private.form_flags(p_date timestamptz,p_class uuid,p_code text) returns text[] language sql stable security definer set search_path='' as $$
  select case when p_date is null then array['Data da resposta ausente']::text[]
    when (p_date at time zone 'America/Sao_Paulo')::date<c.starts_on then array['Resposta anterior à turma']::text[]
    when p_code='F4' and (p_date at time zone 'America/Sao_Paulo')::date<c.followup_on then array['Resposta antes de 3 semanas']::text[]
    else '{}'::text[] end
  from public.classes c where id=p_class;
$$;
create or replace function private.form4_flags(p_date timestamptz,p_class uuid) returns text[] language sql stable security definer set search_path='' as $$
  select private.form_flags(p_date,p_class,'F4');
$$;

-- Rebuild one student's completion header for one form from their linked submissions.
create function private.refresh_submission(p_student uuid,p_class uuid,p_code text) returns void language plpgsql security definer set search_path='' as $$
declare latest public.form4_submissions;sid uuid;rid uuid;combined text[];n integer;
begin
  select id into sid from public.surveys where class_id=p_class and code=p_code;if sid is null then return;end if;
  select * into latest from public.form4_submissions where student_id=p_student and class_id=p_class and state='linked' and form_code=p_code order by submitted_at desc,id desc limit 1;
  if not found then delete from public.response_status where student_id=p_student and survey_id=sid;return;end if;
  select count(*) into n from public.form4_submissions where student_id=p_student and class_id=p_class and state='linked' and form_code=p_code;
  select coalesce(array_agg(distinct flag),'{}') into combined from unnest(
    array(select x from unnest(latest.flags) x where x not in ('Resposta antes de 3 semanas','Resposta anterior à turma','Respostas duplicadas'))
    || coalesce(private.form_flags(latest.submitted_at,p_class,p_code),'{}') || case when n>1 then array['Respostas duplicadas'] else '{}'::text[] end
  ) flag;
  insert into public.response_status(class_id,survey_id,student_id,responded_at,attention) values(p_class,sid,p_student,latest.submitted_at,combined)
  on conflict(survey_id,student_id) do update set responded_at=excluded.responded_at,attention=excluded.attention returning id into rid;
  insert into public.response_answers(response_id,answers) values(rid,latest.answers) on conflict(response_id) do update set answers=excluded.answers;
end;
$$;
-- Every caller of the v2 helper now heals both forms.
create or replace function private.refresh_form4(p_student uuid,p_class uuid) returns void language plpgsql security definer set search_path='' as $$
begin
  perform private.refresh_submission(p_student,p_class,'F3');
  perform private.refresh_submission(p_student,p_class,'F4');
end;
$$;

-- The board now provisions both surveys per class. Form 3 applies during the course.
create or replace function public.import_management(p_rows jsonb,p_filename text) returns integer language plpgsql security definer set search_path='' as $$
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
    insert into public.surveys(class_id,code,name,url,due_date,message_template)
    values(cid,'F3','Form 3','',end_date,E'Olá, {nome}! Aqui é a equipe SIDP — British Council, Fase V. Durante as aulas da turma {turma}, pedimos que você responda ao Form 3 pelo link: {link}\n\nMatrícula: {matricula}\nObrigado!\nEquipe MERL · ARCA')
    on conflict(class_id,code) do update set due_date=excluded.due_date;
    n:=n+1;
    perform private.refresh_submission(f.student_id,cid,f.form_code) from (select distinct student_id,form_code from public.form4_submissions where class_id=cid and state='linked') f;
  end loop;
  insert into public.source_imports(kind,filename,imported_by,row_count,payload) values('management',p_filename,auth.uid(),n,p_rows);
  return n;
end;
$$;

-- Generic response import; Form 4 keeps its original entry point as a wrapper.
create function public.import_form_responses(p_code text,p_rows jsonb,p_source jsonb,p_filename text) returns integer language plpgsql security definer set search_path='' as $$
declare r jsonb;prior public.form4_submissions;sid uuid;cid uuid;current_state text;origin text;flags text[];old_sid uuid;old_cid uuid;n integer:=0;
begin
  if not private.is_admin() then raise exception 'Admin access required' using errcode='42501';end if;
  if p_code not in ('F3','F4') then raise exception 'Invalid form code';end if;
  if jsonb_typeof(p_rows)<>'array' or jsonb_array_length(p_rows)>5000 or jsonb_typeof(p_source)<>'array' or jsonb_array_length(p_source)>5000 then raise exception 'Invalid form dataset';end if;
  for r in select value from jsonb_array_elements(p_rows) loop
    select * into prior from public.form4_submissions where external_id=r->>'external_id';old_sid:=prior.student_id;old_cid:=prior.class_id;
    if prior.id is not null and prior.form_code<>p_code then raise exception 'Submission % belongs to another form',r->>'external_id';end if;
    sid:=nullif(r->>'student_id','')::uuid;cid:=nullif(r->>'class_id','')::uuid;current_state:=r->>'state';origin:='auto';
    select coalesce(array_agg(v),'{}') into flags from jsonb_array_elements_text(coalesce(r->'flags','[]')) v;
    -- A reimport cannot undo an explicitly reviewed match, even with a stale client.
    if prior.match_origin='manual' then sid:=prior.student_id;cid:=prior.class_id;current_state:=prior.state;origin:='manual';
      if prior.source_urn<>coalesce(r->>'source_urn','') or prior.source_name<>coalesce(r->>'source_name','') then flags:=flags||array['Identificação alterada na origem'];end if;
    end if;
    if current_state='linked' and not exists(select 1 from public.enrollments where student_id=sid and class_id=cid and not excluded and attendance_verified) then current_state:='review';sid:=null;cid:=null;flags:=flags||array['Presença não confirmada'];end if;
    insert into public.form4_submissions(external_id,form_code,source_urn,source_name,source_phone,country,submitted_at,student_id,class_id,state,flags,candidates,answers,match_origin,review_reason)
    values(r->>'external_id',p_code,coalesce(r->>'source_urn',''),coalesce(r->>'source_name',''),coalesce(r->>'source_phone',''),coalesce(r->>'country',''),nullif(r->>'submitted_at','')::timestamptz,sid,cid,current_state,flags,coalesce(r->'candidates','[]'),r->'answers',origin,coalesce(prior.review_reason,''))
    on conflict(external_id) do update set source_urn=excluded.source_urn,source_name=excluded.source_name,source_phone=excluded.source_phone,country=excluded.country,submitted_at=excluded.submitted_at,student_id=excluded.student_id,class_id=excluded.class_id,state=excluded.state,flags=excluded.flags,candidates=excluded.candidates,answers=excluded.answers,match_origin=excluded.match_origin,updated_at=now();
    if old_sid is not null then perform private.refresh_submission(old_sid,old_cid,p_code);end if;
    n:=n+1;
  end loop;
  perform private.refresh_submission(pair.student_id,pair.class_id,p_code) from (select distinct student_id,class_id from public.form4_submissions where state='linked' and form_code=p_code) pair;
  perform private.refresh_review_flags();
  insert into public.source_imports(kind,filename,imported_by,row_count,metadata,payload) values(case when p_code='F3' then 'form3' else 'form4' end,p_filename,auth.uid(),jsonb_array_length(p_source),jsonb_build_object('considered',n),p_source);
  return n;
end;
$$;
create or replace function public.import_form4(p_rows jsonb,p_source jsonb,p_filename text) returns integer language plpgsql security definer set search_path='' as $$
begin
  return public.import_form_responses('F4',p_rows,p_source,p_filename);
end;
$$;
-- Review resolution now heals the form the submission belongs to.
create or replace function public.resolve_form4(p_id uuid,p_student_id uuid,p_class_id uuid,p_state text,p_reason text) returns void language plpgsql security definer set search_path='' as $$
declare prior public.form4_submissions;
begin
  if not private.is_admin() then raise exception 'Admin access required' using errcode='42501';end if;
  select * into prior from public.form4_submissions where id=p_id;if not found then raise exception 'Submission not found';end if;
  if p_state not in ('linked','review','ignored') then raise exception 'Invalid resolution';end if;
  if trim(coalesce(p_reason,''))='' then raise exception 'Record a review reason';end if;
  if p_state='linked' and (prior.submitted_at is null or not exists(select 1 from public.enrollments where student_id=p_student_id and class_id=p_class_id and not excluded and attendance_verified)) then raise exception 'Check response date and participant attendance';end if;
  update public.form4_submissions set state=p_state,student_id=case when p_state='linked' then p_student_id else null end,class_id=case when p_state='linked' then p_class_id else null end,match_origin='manual',review_reason=trim(p_reason),updated_at=now(),flags=array(select x from unnest(flags) x where x not in ('Sem correspondência','Mais de uma correspondência','Conferir correspondência')) where id=p_id;
  if prior.student_id is not null then perform private.refresh_submission(prior.student_id,prior.class_id,prior.form_code);end if;
  if p_state='linked' then perform private.refresh_submission(p_student_id,p_class_id,prior.form_code);end if;
  perform private.refresh_review_flags();
end;
$$;

-- Issues board: field problems tracked next to the data they affect.
create table public.issues(
  id uuid primary key default gen_random_uuid(),
  category text not null check(category in ('frequencia','chamada','urn','formulario','outra')),
  title text not null check(length(trim(title))>0),
  detail text not null default '',
  recommendation text not null default '',
  class_ids uuid[] not null default '{}',
  status text not null default 'aberta' check(status in ('aberta','resolvida')),
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolution_note text not null default ''
);
create index issues_status_idx on public.issues(status,created_at desc);
alter table public.issues enable row level security;
-- Partners see only issues that touch one of their classes; admins see everything.
create policy issues_read on public.issues for select to authenticated using(
  private.is_admin() or exists(select 1 from public.class_access a where a.user_id=(select auth.uid()) and a.class_id=any(issues.class_ids))
);
grant select on public.issues to authenticated;
revoke all on public.issues from anon;

create function public.save_issue(p_id uuid,p_category text,p_title text,p_detail text,p_recommendation text,p_class_ids uuid[]) returns uuid language plpgsql security definer set search_path='' as $$
declare rid uuid;
begin
  if not private.is_admin() then raise exception 'Admin access required' using errcode='42501';end if;
  if exists(select 1 from unnest(coalesce(p_class_ids,'{}')) cid where not exists(select 1 from public.classes where id=cid)) then raise exception 'Unknown class in issue';end if;
  if p_id is null then
    insert into public.issues(category,title,detail,recommendation,class_ids,created_by)
    values(p_category,trim(p_title),coalesce(p_detail,''),coalesce(p_recommendation,''),coalesce(p_class_ids,'{}'),auth.uid()) returning id into rid;
  else
    update public.issues set category=p_category,title=trim(p_title),detail=coalesce(p_detail,''),recommendation=coalesce(p_recommendation,''),class_ids=coalesce(p_class_ids,'{}') where id=p_id returning id into rid;
    if rid is null then raise exception 'Issue not found';end if;
  end if;
  return rid;
end;
$$;
create function public.set_issue_status(p_id uuid,p_status text,p_note text) returns void language plpgsql security definer set search_path='' as $$
begin
  if not private.is_admin() then raise exception 'Admin access required' using errcode='42501';end if;
  if p_status not in ('aberta','resolvida') then raise exception 'Invalid status';end if;
  update public.issues set status=p_status,resolved_at=case when p_status='resolvida' then now() else null end,resolution_note=case when p_status='resolvida' then trim(coalesce(p_note,'')) else '' end where id=p_id;
  if not found then raise exception 'Issue not found';end if;
end;
$$;
revoke all on function private.form_flags(timestamptz,uuid,text),private.refresh_submission(uuid,uuid,text),public.import_form_responses(text,jsonb,jsonb,text),public.save_issue(uuid,text,text,text,text,uuid[]),public.set_issue_status(uuid,text,text) from public;
grant execute on function public.import_form_responses(text,jsonb,jsonb,text),public.save_issue(uuid,text,text,text,text,uuid[]),public.set_issue_status(uuid,text,text) to authenticated;
commit;
