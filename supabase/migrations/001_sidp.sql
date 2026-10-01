-- Run once in the SQL editor of a new Supabase project.
begin;
create schema if not exists private;
revoke all on schema private from public;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique, full_name text not null default '',
  role text not null default 'partner' check(role in ('admin','partner'))
);
create table public.classes (
  id uuid primary key default gen_random_uuid(), code text not null unique,
  name text not null default '', partner text not null default ''
);
create table public.class_access (
  user_id uuid not null references public.profiles(id) on delete cascade,
  class_id uuid not null references public.classes(id) on delete cascade,
  primary key(user_id,class_id)
);
create table public.surveys (
  id uuid primary key default gen_random_uuid(), class_id uuid not null references public.classes(id) on delete cascade,
  code text not null, name text not null, url text not null default '' check(url='' or url ~ '^https://'),
  due_date date, message_template text not null,
  unique(class_id,code), unique(id,class_id)
);
create table public.students (
  id uuid primary key default gen_random_uuid(), urn text not null unique check(urn<>'' and urn !~ '\s'),
  name text not null check(length(trim(name))>0), phone text not null default '',
  created_at timestamptz not null default now()
);
create table public.enrollments (
  student_id uuid not null references public.students(id) on delete cascade,
  class_id uuid not null references public.classes(id) on delete cascade,
  excluded boolean not null default false, exclusion_reason text not null default '',
  primary key(student_id,class_id)
);
create table public.response_status (
  id uuid primary key default gen_random_uuid(), class_id uuid not null,
  survey_id uuid not null, student_id uuid not null, responded_at timestamptz not null default now(),
  unique(survey_id,student_id),
  foreign key(survey_id,class_id) references public.surveys(id,class_id) on delete cascade,
  foreign key(student_id,class_id) references public.enrollments(student_id,class_id) on delete cascade
);
-- Separate table: partners may read response status, never the answers.
create table public.response_answers (
  response_id uuid primary key references public.response_status(id) on delete cascade,
  answers jsonb not null default '{}'::jsonb check(jsonb_typeof(answers)='object')
);
create table public.import_batches (
  id uuid primary key default gen_random_uuid(), class_id uuid not null references public.classes(id),
  survey_id uuid not null references public.surveys(id), kind text not null check(kind in ('roster','responses')),
  filename text not null, imported_by uuid not null references public.profiles(id),
  imported_at timestamptz not null default now(), row_count integer not null,
  rows jsonb not null -- original dataset rows retained for MERL audit / later analysis
);
create index enrollment_class_idx on public.enrollments(class_id);
create index response_class_idx on public.response_status(class_id);
create index surveys_class_idx on public.surveys(class_id);

create function private.is_admin() returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.profiles where id=(select auth.uid()) and role='admin');
$$;
create function private.can_access(p_class uuid) returns boolean language sql stable security definer set search_path='' as $$
  select private.is_admin() or exists(select 1 from public.class_access where user_id=(select auth.uid()) and class_id=p_class);
$$;
create function private.can_read_student(p_student uuid) returns boolean language sql stable security definer set search_path='' as $$
  select private.is_admin() or exists(select 1 from public.enrollments e join public.class_access a on a.class_id=e.class_id where a.user_id=(select auth.uid()) and e.student_id=p_student and not e.excluded);
$$;
grant usage on schema private to authenticated;
revoke all on all functions in schema private from public;
grant execute on all functions in schema private to authenticated;

create function private.create_profile() returns trigger language plpgsql security definer set search_path='' as $$
begin
  insert into public.profiles(id,email,full_name) values(new.id,lower(new.email),coalesce(new.raw_user_meta_data->>'full_name',''));
  return new;
end;
$$;
create trigger on_auth_user_created after insert on auth.users for each row execute function private.create_profile();
-- Backfill pre-existing Auth accounts; never trusts user-supplied role metadata.
insert into public.profiles(id,email,full_name)
select id,lower(email),coalesce(raw_user_meta_data->>'full_name','') from auth.users where email is not null on conflict(id) do nothing;

alter table public.profiles enable row level security;
alter table public.classes enable row level security;
alter table public.class_access enable row level security;
alter table public.surveys enable row level security;
alter table public.students enable row level security;
alter table public.enrollments enable row level security;
alter table public.response_status enable row level security;
alter table public.response_answers enable row level security;
alter table public.import_batches enable row level security;

create policy profiles_read on public.profiles for select to authenticated using(id=(select auth.uid()) or private.is_admin());
create policy classes_read on public.classes for select to authenticated using(private.can_access(id));
create policy access_read on public.class_access for select to authenticated using(user_id=(select auth.uid()) or private.is_admin());
create policy surveys_read on public.surveys for select to authenticated using(private.can_access(class_id));
create policy surveys_admin on public.surveys for all to authenticated using(private.is_admin()) with check(private.is_admin());
create policy students_read on public.students for select to authenticated using(private.can_read_student(id));
create policy enrollments_read on public.enrollments for select to authenticated using(private.is_admin() or (not excluded and private.can_access(class_id)));
create policy response_read on public.response_status for select to authenticated using(private.is_admin() or (private.can_access(class_id) and exists(select 1 from public.enrollments e where e.student_id=response_status.student_id and e.class_id=response_status.class_id and not e.excluded)));
create policy answers_admin on public.response_answers for select to authenticated using(private.is_admin());
create policy imports_admin on public.import_batches for select to authenticated using(private.is_admin());
-- All other writes go through checked, atomic admin RPCs.
grant select on public.profiles,public.classes,public.class_access,public.students,public.enrollments,public.response_status,public.response_answers,public.import_batches to authenticated;
grant select,insert,update,delete on public.surveys to authenticated;
revoke all on public.profiles,public.classes,public.class_access,public.students,public.enrollments,public.response_status,public.response_answers,public.import_batches,public.surveys from anon;

create function public.import_dataset(p_class_id uuid,p_survey_id uuid,p_kind text,p_rows jsonb,p_filename text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r jsonb; sid uuid; rid uuid; response_time timestamptz; old_time timestamptz; n integer:=0; urn_value text; name_value text;
begin
  if not private.is_admin() then raise exception 'Admin access required' using errcode='42501'; end if;
  if p_kind not in ('roster','responses') then raise exception 'Invalid import type'; end if;
  if not exists(select 1 from public.surveys where id=p_survey_id and class_id=p_class_id) then raise exception 'Survey/class mismatch'; end if;
  if jsonb_typeof(p_rows)<>'array' or jsonb_array_length(p_rows)=0 or jsonb_array_length(p_rows)>5000 then raise exception 'Import 1 to 5000 rows'; end if;
  if (select count(*) from jsonb_array_elements(p_rows))<>(select count(distinct upper(trim(x->>'urn'))) from jsonb_array_elements(p_rows) x) then raise exception 'Duplicate URNs in import'; end if;
  for r in select value from jsonb_array_elements(p_rows) loop
    urn_value:=upper(trim(r->>'urn')); name_value:=trim(coalesce(r->>'name',''));
    if urn_value is null or urn_value='' or urn_value ~ '\s' then raise exception 'Invalid URN'; end if;
    select id into sid from public.students where urn=urn_value;
    if sid is null then
      if name_value='' then raise exception 'Name required for new URN %',urn_value; end if;
      insert into public.students(urn,name,phone) values(urn_value,name_value,coalesce(r->>'phone','')) returning id into sid;
    else
      update public.students set name=coalesce(nullif(name_value,''),name),phone=coalesce(nullif(r->>'phone',''),phone) where id=sid;
    end if;
    -- Answer imports must match an existing roster: unmatched students abort the batch.
    if p_kind='responses' and not exists(select 1 from public.enrollments where student_id=sid and class_id=p_class_id) then raise exception 'URN % is not enrolled in this class; import roster first',urn_value; end if;
    if p_kind='roster' then insert into public.enrollments(student_id,class_id) values(sid,p_class_id) on conflict do nothing; end if;
    if p_kind='responses' or coalesce((r->>'responded')::boolean,false) then
      response_time:=coalesce(nullif(r->>'submitted_at','')::timestamptz,now());
      select responded_at into old_time from public.response_status where survey_id=p_survey_id and student_id=sid;
      if p_kind='roster' and old_time is not null then response_time:=old_time; end if;
      insert into public.response_status(class_id,survey_id,student_id,responded_at) values(p_class_id,p_survey_id,sid,response_time)
      on conflict(survey_id,student_id) do update set responded_at=greatest(public.response_status.responded_at,excluded.responded_at) returning id into rid;
      if old_time is null or (p_kind='responses' and response_time>=old_time) then
        insert into public.response_answers(response_id,answers) values(rid,coalesce(r->'answers','{}'::jsonb))
        on conflict(response_id) do update set answers=excluded.answers;
      end if;
    end if;
    -- A pending roster import never erases an existing response or exclusion.
    n:=n+1;
  end loop;
  insert into public.import_batches(class_id,survey_id,kind,filename,imported_by,row_count,rows) values(p_class_id,p_survey_id,p_kind,p_filename,auth.uid(),n,p_rows);
  return jsonb_build_object('imported',n);
end;
$$;
create function public.update_student(p_student_id uuid,p_name text,p_phone text) returns void language plpgsql security definer set search_path='' as $$
begin
  if not private.is_admin() then raise exception 'Admin access required' using errcode='42501'; end if;
  update public.students set name=trim(p_name),phone=trim(p_phone) where id=p_student_id;
  if not found then raise exception 'Student not found'; end if;
end;
$$;
create function public.set_exclusion(p_student_id uuid,p_class_id uuid,p_excluded boolean,p_reason text) returns void language plpgsql security definer set search_path='' as $$
begin
  if not private.is_admin() then raise exception 'Admin access required' using errcode='42501'; end if;
  if p_excluded and trim(coalesce(p_reason,''))='' then raise exception 'Provide an exclusion reason'; end if;
  update public.enrollments set excluded=p_excluded,exclusion_reason=case when p_excluded then trim(p_reason) else '' end where student_id=p_student_id and class_id=p_class_id;
  if not found then raise exception 'Enrollment not found'; end if;
end;
$$;
create function public.move_student(p_student_id uuid,p_from_class uuid,p_to_class uuid) returns void language plpgsql security definer set search_path='' as $$
declare s public.surveys; target_survey uuid;
begin
  if not private.is_admin() then raise exception 'Admin access required' using errcode='42501'; end if;
  if p_from_class=p_to_class then return; end if;
  if exists(select 1 from public.enrollments where student_id=p_student_id and class_id=p_to_class) then raise exception 'Student already belongs to target class'; end if;
  insert into public.enrollments(student_id,class_id,excluded,exclusion_reason) select student_id,p_to_class,excluded,exclusion_reason from public.enrollments where student_id=p_student_id and class_id=p_from_class;
  if not found then raise exception 'Enrollment not found'; end if;
  for s in select * from public.surveys where class_id=p_from_class loop
    if exists(select 1 from public.response_status where survey_id=s.id and student_id=p_student_id) then
      insert into public.surveys(class_id,code,name,url,due_date,message_template) values(p_to_class,s.code,s.name,s.url,s.due_date,s.message_template) on conflict(class_id,code) do nothing;
      select id into target_survey from public.surveys where class_id=p_to_class and code=s.code;
      update public.response_status set class_id=p_to_class,survey_id=target_survey where survey_id=s.id and student_id=p_student_id;
    end if;
  end loop;
  delete from public.enrollments where student_id=p_student_id and class_id=p_from_class;
end;
$$;
create function public.set_class_access(p_email text,p_class_id uuid,p_granted boolean) returns void language plpgsql security definer set search_path='' as $$
declare target_user uuid;
begin
  if not private.is_admin() then raise exception 'Admin access required' using errcode='42501'; end if;
  select id into target_user from public.profiles where email=lower(trim(p_email)) and role='partner';
  if target_user is null then raise exception 'Create this partner account in Supabase Auth first'; end if;
  if p_granted then insert into public.class_access(user_id,class_id) values(target_user,p_class_id) on conflict do nothing;
  else delete from public.class_access where user_id=target_user and class_id=p_class_id; end if;
end;
$$;
-- One transaction for editing contacts, exclusion, and class reassignment.
create function public.save_student_details(p_student_id uuid,p_class_id uuid,p_to_class uuid,p_name text,p_phone text,p_excluded boolean,p_reason text) returns void language plpgsql security definer set search_path='' as $$
begin
  if not private.is_admin() then raise exception 'Admin access required' using errcode='42501'; end if;
  perform public.update_student(p_student_id,p_name,p_phone);
  perform public.set_exclusion(p_student_id,p_class_id,p_excluded,p_reason);
  perform public.move_student(p_student_id,p_class_id,p_to_class);
end;
$$;
revoke all on function public.save_student_details(uuid,uuid,uuid,text,text,boolean,text),private.create_profile() from public;
grant execute on function public.save_student_details(uuid,uuid,uuid,text,text,boolean,text) to authenticated;
revoke all on function public.import_dataset(uuid,uuid,text,jsonb,text),public.update_student(uuid,text,text),public.set_exclusion(uuid,uuid,boolean,text),public.move_student(uuid,uuid,uuid),public.set_class_access(text,uuid,boolean) from public;
grant execute on function public.import_dataset(uuid,uuid,text,jsonb,text),public.update_student(uuid,text,text),public.set_exclusion(uuid,uuid,boolean,text),public.move_student(uuid,uuid,uuid),public.set_class_access(text,uuid,boolean) to authenticated;

commit;
