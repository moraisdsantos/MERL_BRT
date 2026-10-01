-- v3: private identities, URN-only partner roster, admin-only AI analysis.
begin;
drop policy students_read on public.students;
create policy students_admin_read on public.students for select to authenticated using(private.is_admin());

create function public.get_partner_students() returns table(id uuid,urn text,phone text)
language sql stable security definer set search_path='' as $$
  select s.id,s.urn,s.phone from public.students s where exists(
    select 1 from public.enrollments e join public.class_access a on a.class_id=e.class_id
    where e.student_id=s.id and a.user_id=(select auth.uid()) and not e.excluded and e.attendance_verified
  ) order by s.urn;
$$;
revoke all on function public.get_partner_students() from public,anon;
grant execute on function public.get_partner_students() to authenticated;

create table public.ai_analyses(
  id uuid primary key default gen_random_uuid(),class_id uuid not null references public.classes(id),
  created_by uuid not null references public.profiles(id),created_at timestamptz not null default now(),completed_at timestamptz,
  status text not null default 'running' check(status in ('running','completed','failed')),
  input_hash text not null,snapshot jsonb not null,result jsonb,model text not null default '',error text not null default ''
);
create index ai_class_time_idx on public.ai_analyses(class_id,created_at desc);
alter table public.ai_analyses enable row level security;
create policy ai_admin_read on public.ai_analyses for select to authenticated using(private.is_admin());
grant select on public.ai_analyses to authenticated;
revoke all on public.ai_analyses from anon;

-- Only identity, course dates and completion metadata are sent for reconciliation.
-- No telephone numbers, answers to survey questions, edit URLs or PDF binaries.
create function private.ai_snapshot(p_class uuid) returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object(
    'as_of',(now() at time zone 'America/Sao_Paulo')::date::text,
    'class',jsonb_build_object('id',c.id,'code',c.code,'name',c.name,'starts_on',c.starts_on,'ends_on',c.ends_on,'followup_on',c.followup_on),
    'classes',coalesce((select jsonb_agg(jsonb_build_object('id',x.id,'code',x.code,'starts_on',x.starts_on,'ends_on',x.ends_on,'followup_on',x.followup_on) order by x.code) from public.classes x where x.management_imported),'[]'::jsonb),
    'participants',coalesce((select jsonb_agg(jsonb_build_object('student_id',s.id,'urn',s.urn,'name',s.name,'excluded',e.excluded,'verified',e.attendance_verified,'review_pending',e.review_pending,'flags',e.attention,'responded_at',r.responded_at) order by s.id)
      from public.enrollments e join public.students s on s.id=e.student_id
      left join public.surveys sv on sv.class_id=e.class_id and sv.code='F4'
      left join public.response_status r on r.student_id=e.student_id and r.survey_id=sv.id where e.class_id=c.id),'[]'::jsonb),
    'submissions',coalesce((select jsonb_agg(jsonb_build_object('id',f.id,'urn',f.source_urn,'name',f.source_name,'submitted_at',f.submitted_at,'state',f.state,'student_id',f.student_id,'class_id',f.class_id,'flags',f.flags,'match_origin',f.match_origin) order by f.id) from public.form4_submissions f),'[]'::jsonb),
    'imports',coalesce((select jsonb_agg(jsonb_build_object('kind',kind,'last_import',last_import) order by kind) from (select kind,max(imported_at) last_import from public.source_imports group by kind) x),'[]'::jsonb)
  ) from public.classes c where c.id=p_class and c.management_imported;
$$;
revoke all on function private.ai_snapshot(uuid) from public,anon,authenticated;

create function public.begin_ai_analysis(p_class_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare snap jsonb; rid uuid;
begin
  if not private.is_admin() then raise exception 'Admin access required' using errcode='42501';end if;
  -- Serialize reservations globally; limits still apply across concurrent callers.
  perform pg_advisory_xact_lock(73314003);
  snap:=private.ai_snapshot(p_class_id);
  if snap is null then raise exception 'Importe a turma pelo quadro de gestão.';end if;
  if not exists(select 1 from public.enrollments where class_id=p_class_id and attendance_verified and not excluded) then raise exception 'Importe e confirme a lista de presença.';end if;
  if not exists(select 1 from public.source_imports where kind='form4') then raise exception 'Importe o dataset do Form 4 antes da análise.';end if;
  if jsonb_array_length(snap->'participants')>300 or jsonb_array_length(snap->'submissions')>1000 or octet_length(snap::text)>250000 then raise exception 'Dataset acima do limite desta análise: 300 alunos, 1000 submissões ou 250 KB.';end if;
  update public.ai_analyses set status='failed',completed_at=now(),error='Análise interrompida. Execute novamente.' where status='running' and created_at<now()-interval '3 minutes';
  if exists(select 1 from public.ai_analyses where class_id=p_class_id and status='running') then raise exception 'Já há uma análise em andamento nesta turma.';end if;
  if (select count(*) from public.ai_analyses where created_by=auth.uid() and created_at>now()-interval '1 hour')>=10 or (select count(*) from public.ai_analyses where created_at>now()-interval '1 hour')>=40 then raise exception 'Limite de análises atingido. Aguarde uma hora.';end if;
  insert into public.ai_analyses(class_id,created_by,input_hash,snapshot) values(p_class_id,auth.uid(),md5(snap::text),snap) returning id into rid;
  return jsonb_build_object('run_id',rid,'snapshot',snap);
end;
$$;

create function public.finish_ai_analysis(p_run_id uuid,p_result jsonb,p_model text,p_error text default '') returns void language plpgsql security definer set search_path='' as $$
begin
  if not private.is_admin() then raise exception 'Admin access required' using errcode='42501';end if;
  if not exists(select 1 from public.ai_analyses where id=p_run_id and created_by=auth.uid() and status='running') then raise exception 'Análise não disponível para esta conta.';end if;
  if octet_length(coalesce(p_result::text,''))>200000 then raise exception 'Resultado acima do limite.';end if;
  update public.ai_analyses set status=case when p_result is null then 'failed' else 'completed' end,result=p_result,model=left(p_model,100),error=left(coalesce(p_error,''),500),completed_at=now() where id=p_run_id;
end;
$$;
create function public.latest_ai_analysis(p_class_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare a public.ai_analyses;
begin
  if not private.is_admin() then raise exception 'Admin access required' using errcode='42501';end if;
  select * into a from public.ai_analyses where class_id=p_class_id order by created_at desc,id desc limit 1;
  if not found then return null;end if;
  return jsonb_build_object('id',a.id,'class_id',a.class_id,'created_at',a.created_at,'completed_at',a.completed_at,'status',a.status,'model',a.model,'result',a.result,'error',a.error,'is_current',a.input_hash=md5(private.ai_snapshot(p_class_id)::text));
end;
$$;
revoke all on function public.begin_ai_analysis(uuid),public.finish_ai_analysis(uuid,jsonb,text,text),public.latest_ai_analysis(uuid) from public,anon;
grant execute on function public.begin_ai_analysis(uuid),public.finish_ai_analysis(uuid,jsonb,text,text),public.latest_ai_analysis(uuid) to authenticated;
commit;
