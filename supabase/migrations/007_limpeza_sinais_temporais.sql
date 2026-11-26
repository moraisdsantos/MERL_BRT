-- 007: refresh_submission limpa sinais temporais antigos antes de recalcular (prazo do Form 4 segue 3 semanas)
create or replace function private.form_flags(p_date timestamptz,p_class uuid,p_code text) returns text[] language sql stable security definer set search_path='' as $$
  select case when p_date is null then array['Data da resposta ausente']::text[]
    when (p_date at time zone 'America/Sao_Paulo')::date<c.starts_on then array['Resposta anterior à turma']::text[]
    when p_code='F4' and (p_date at time zone 'America/Sao_Paulo')::date<c.followup_on then array['Resposta antes de 3 semanas']::text[]
    else '{}'::text[] end
  from public.classes c where id=p_class;
$$;
create or replace function private.refresh_submission(p_student uuid,p_class uuid,p_code text) returns void language plpgsql security definer set search_path='' as $$
declare latest public.form4_submissions;sid uuid;rid uuid;combined text[];n integer;
begin
  select id into sid from public.surveys where class_id=p_class and code=p_code;if sid is null then return;end if;
  select * into latest from public.form4_submissions where student_id=p_student and class_id=p_class and state='linked' and form_code=p_code order by submitted_at desc,id desc limit 1;
  if not found then delete from public.response_status where student_id=p_student and survey_id=sid;return;end if;
  select count(*) into n from public.form4_submissions where student_id=p_student and class_id=p_class and state='linked' and form_code=p_code;
  select coalesce(array_agg(distinct flag),'{}') into combined from unnest(
    array(select x from unnest(latest.flags) x where x not in ('Resposta antes de 3 semanas','Resposta antes de 4 semanas','Resposta anterior à turma','Respostas duplicadas'))
    || coalesce(private.form_flags(latest.submitted_at,p_class,p_code),'{}') || case when n>1 then array['Respostas duplicadas'] else '{}'::text[] end
  ) flag;
  insert into public.response_status(class_id,survey_id,student_id,responded_at,attention) values(p_class,sid,p_student,latest.submitted_at,combined)
  on conflict(survey_id,student_id) do update set responded_at=excluded.responded_at,attention=excluded.attention returning id into rid;
  insert into public.response_answers(response_id,answers) values(rid,latest.answers) on conflict(response_id) do update set answers=excluded.answers;
end;
$$;
-- Recalcula os cabeçalhos com a regra nova
select private.refresh_submission(p.student_id,p.class_id,p.form_code) from (select distinct student_id,class_id,form_code from public.form4_submissions where state='linked') p;
select private.refresh_review_flags();
