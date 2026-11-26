-- 006: nível da turma, Form 5 (Pré/Pós), mensagens sem {nome}
-- Aplicada no projeto sidp-merl em 26/11/2026 via MCP; mantida aqui para versionamento.
alter table public.classes add column if not exists level text not null default 'Básico';
alter table public.classes drop constraint if exists classes_level_check;
alter table public.classes add constraint classes_level_check check (level in ('Básico','Intermediário'));

-- name passa a guardar só a usina; o turno já vive em shift
update public.classes set name=split_part(name,' · ',1) where name like '% · %';

-- Form 5 (Pré/Pós)
alter table public.form4_submissions drop constraint form4_submissions_form_code_check;
alter table public.form4_submissions add constraint form4_submissions_form_code_check check (form_code in ('F3','F4','F5PRE','F5POS'));
alter table public.source_imports drop constraint source_imports_kind_check;
alter table public.source_imports add constraint source_imports_kind_check check (kind in ('management','attendance','form4','form3','form5'));

insert into public.surveys(class_id,code,name,url,due_date,message_template)
select c.id,'F5PRE','Form 5 (Pré)','',c.starts_on,E'Olá! Aqui é a equipe do projeto SIDP. Antes da primeira aula da turma {turma}, pedimos que você responda ao Form 5 pelo link: {link}\n\nMatrícula: {matricula}\nObrigado!\nEquipe MERL · ARCA'
from public.classes c on conflict(class_id,code) do nothing;
insert into public.surveys(class_id,code,name,url,due_date,message_template)
select c.id,'F5POS','Form 5 (Pós)','',c.ends_on,E'Olá! Aqui é a equipe do projeto SIDP. Na última aula da turma {turma}, pedimos que você responda ao Form 5 pelo link: {link}\n\nMatrícula: {matricula}\nObrigado!\nEquipe MERL · ARCA'
from public.classes c on conflict(class_id,code) do nothing;

-- mensagens sem {nome} e sem travessão
update public.surveys set message_template=E'Olá! Aqui é a equipe do projeto SIDP. Durante as aulas da turma {turma}, pedimos que você responda ao Form 3 pelo link: {link}\n\nMatrícula: {matricula}\nObrigado!\nEquipe MERL · ARCA' where code='F3' and message_template like '%{nome}%';
update public.surveys set message_template=E'Olá! Aqui é a equipe do projeto SIDP. Sua turma {turma} encerrou há três semanas. Você pode responder ao Form 4 pelo link: {link}\n\nMatrícula: {matricula}\nObrigado!\nEquipe MERL · ARCA' where code='F4' and message_template like '%{nome}%';

-- import_management: nível, Form 5, mensagens novas
create or replace function public.import_management(p_rows jsonb, p_filename text)
returns integer language plpgsql security definer set search_path to ''
as $function$
declare r jsonb;cid uuid;n integer:=0;start_date date;end_date date;
begin
  if not private.is_admin() then raise exception 'Admin access required' using errcode='42501';end if;
  if jsonb_typeof(p_rows)<>'array' or jsonb_array_length(p_rows) not between 1 and 1000 then raise exception 'Invalid class dataset';end if;
  for r in select value from jsonb_array_elements(p_rows) loop
    if coalesce(r->>'code','') !~ '^T[0-9]{2,4}$' then raise exception 'Invalid class code';end if;
    if nullif(r->>'level','') is not null and r->>'level' not in ('Básico','Intermediário') then raise exception 'Invalid class level';end if;
    start_date:=(r->>'starts_on')::date;end_date:=(r->>'ends_on')::date;
    if start_date is null or end_date is null or end_date<start_date then raise exception 'Invalid class dates';end if;
    insert into public.classes(code,name,partner,starts_on,ends_on,followup_on,shift,level,management_imported,management_source)
    values(r->>'code',coalesce(nullif(r->>'name',''),r->>'code'),'',start_date,end_date,end_date+21,coalesce(r->>'shift',''),coalesce(nullif(r->>'level',''),'Básico'),true,coalesce(r->'source','{}'))
    on conflict(code) do update set name=excluded.name,starts_on=excluded.starts_on,ends_on=excluded.ends_on,followup_on=excluded.followup_on,shift=excluded.shift,level=coalesce(nullif(r->>'level',''),public.classes.level),management_imported=true,management_source=excluded.management_source returning id into cid;
    insert into public.surveys(class_id,code,name,url,due_date,message_template)
    values(cid,'F4','Form 4',case when r->>'url' ~ '^https://' then r->>'url' else '' end,end_date+21,E'Olá! Aqui é a equipe do projeto SIDP. Sua turma {turma} encerrou há três semanas. Você pode responder ao Form 4 pelo link: {link}\n\nMatrícula: {matricula}\nObrigado!\nEquipe MERL · ARCA')
    on conflict(class_id,code) do update set due_date=excluded.due_date,url=coalesce(nullif(excluded.url,''),public.surveys.url);
    insert into public.surveys(class_id,code,name,url,due_date,message_template)
    values(cid,'F3','Form 3','',end_date,E'Olá! Aqui é a equipe do projeto SIDP. Durante as aulas da turma {turma}, pedimos que você responda ao Form 3 pelo link: {link}\n\nMatrícula: {matricula}\nObrigado!\nEquipe MERL · ARCA')
    on conflict(class_id,code) do update set due_date=excluded.due_date;
    insert into public.surveys(class_id,code,name,url,due_date,message_template)
    values(cid,'F5PRE','Form 5 (Pré)','',start_date,E'Olá! Aqui é a equipe do projeto SIDP. Antes da primeira aula da turma {turma}, pedimos que você responda ao Form 5 pelo link: {link}\n\nMatrícula: {matricula}\nObrigado!\nEquipe MERL · ARCA')
    on conflict(class_id,code) do update set due_date=excluded.due_date;
    insert into public.surveys(class_id,code,name,url,due_date,message_template)
    values(cid,'F5POS','Form 5 (Pós)','',end_date,E'Olá! Aqui é a equipe do projeto SIDP. Na última aula da turma {turma}, pedimos que você responda ao Form 5 pelo link: {link}\n\nMatrícula: {matricula}\nObrigado!\nEquipe MERL · ARCA')
    on conflict(class_id,code) do update set due_date=excluded.due_date;
    n:=n+1;
    perform private.refresh_submission(f.student_id,cid,f.form_code) from (select distinct student_id,form_code from public.form4_submissions where class_id=cid and state='linked') f;
  end loop;
  insert into public.source_imports(kind,filename,imported_by,row_count,payload) values('management',p_filename,auth.uid(),n,p_rows);
  return n;
end;
$function$;

-- import_form_responses: aceita Form 5 (Pré/Pós)
create or replace function public.import_form_responses(p_code text, p_rows jsonb, p_source jsonb, p_filename text)
returns integer language plpgsql security definer set search_path to ''
as $function$
declare r jsonb;prior public.form4_submissions;sid uuid;cid uuid;current_state text;origin text;flags text[];old_sid uuid;old_cid uuid;n integer:=0;
begin
  if not private.is_admin() then raise exception 'Admin access required' using errcode='42501';end if;
  if p_code not in ('F3','F4','F5PRE','F5POS') then raise exception 'Invalid form code';end if;
  if jsonb_typeof(p_rows)<>'array' or jsonb_array_length(p_rows)>5000 or jsonb_typeof(p_source)<>'array' or jsonb_array_length(p_source)>5000 then raise exception 'Invalid form dataset';end if;
  for r in select value from jsonb_array_elements(p_rows) loop
    select * into prior from public.form4_submissions where external_id=r->>'external_id';old_sid:=prior.student_id;old_cid:=prior.class_id;
    if prior.id is not null and prior.form_code<>p_code then raise exception 'Submission % belongs to another form',r->>'external_id';end if;
    sid:=nullif(r->>'student_id','')::uuid;cid:=nullif(r->>'class_id','')::uuid;current_state:=r->>'state';origin:='auto';
    select coalesce(array_agg(v),'{}') into flags from jsonb_array_elements_text(coalesce(r->'flags','[]')) v;
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
  insert into public.source_imports(kind,filename,imported_by,row_count,metadata,payload) values(case when p_code='F4' then 'form4' when p_code='F3' then 'form3' else 'form5' end,p_filename,auth.uid(),jsonb_array_length(p_source),jsonb_build_object('considered',n),p_source);
  return n;
end;
$function$;
