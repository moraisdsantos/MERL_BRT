-- 008: painel público por turma via link, com registro de mensagens de WhatsApp
-- (aplicada no sidp-merl como links_publicos_turma)
create table public.class_links(
  class_id uuid primary key references public.classes(id) on delete cascade,
  token text not null unique,
  created_at timestamptz not null default now()
);
alter table public.class_links enable row level security;
create policy class_links_admin on public.class_links for all to authenticated using (private.is_admin()) with check (private.is_admin());
grant select,insert,update,delete on public.class_links to authenticated;

create table public.message_log(
  id uuid primary key default gen_random_uuid(),
  class_id uuid not null references public.classes(id) on delete cascade,
  student_id uuid not null references public.students(id) on delete cascade,
  form_code text not null check (form_code in ('F3','F4','F5PRE','F5POS')),
  sent_at timestamptz not null default now()
);
create index message_log_lookup on public.message_log(class_id,student_id,form_code,sent_at desc);
alter table public.message_log enable row level security;
create policy message_log_admin on public.message_log for select to authenticated using (private.is_admin());
grant select on public.message_log to authenticated;

-- Admin gera (ou rotaciona) o link da turma; o token é a credencial do painel.
create or replace function public.share_class_link(p_class_id uuid, p_rotate boolean default false) returns text
language plpgsql security definer set search_path to '' as $$
declare t text;
begin
  if not private.is_admin() then raise exception 'Admin access required' using errcode='42501'; end if;
  select token into t from public.class_links where class_id=p_class_id;
  if t is null or p_rotate then
    t:=replace(gen_random_uuid()::text||gen_random_uuid()::text,'-','');
    insert into public.class_links(class_id,token) values(p_class_id,t)
    on conflict(class_id) do update set token=excluded.token,created_at=now();
  end if;
  return t;
end;$$;

create or replace function public.revoke_class_link(p_class_id uuid) returns void
language plpgsql security definer set search_path to '' as $$
begin
  if not private.is_admin() then raise exception 'Admin access required' using errcode='42501'; end if;
  delete from public.class_links where class_id=p_class_id;
end;$$;

-- Painel público: URN, telefone, status por formulário e última mensagem enviada. Sem nomes.
create or replace function public.get_class_board(p_token text) returns jsonb
language plpgsql stable security definer set search_path to '' as $$
declare cid uuid;result jsonb;
begin
  select class_id into cid from public.class_links where token=p_token;
  if cid is null then raise exception 'Link inválido ou revogado'; end if;
  select jsonb_build_object(
    'class',(select jsonb_build_object('name',c.name,'shift',c.shift,'level',c.level,'starts_on',c.starts_on,'ends_on',c.ends_on,'followup_on',c.followup_on) from public.classes c where c.id=cid),
    'surveys',coalesce((select jsonb_agg(jsonb_build_object('code',s.code,'name',s.name,'url',s.url,'message_template',s.message_template,'due_date',s.due_date) order by s.code) from public.surveys s where s.class_id=cid),'[]'::jsonb),
    'students',coalesce((select jsonb_agg(jsonb_build_object(
        'urn',st.urn,'phone',st.phone,
        'responses',(select coalesce(jsonb_object_agg(s2.code,rs.responded_at),'{}'::jsonb) from public.response_status rs join public.surveys s2 on s2.id=rs.survey_id where rs.student_id=st.id and rs.class_id=cid),
        'sent',(select coalesce(jsonb_object_agg(ml.form_code,ml.last_sent),'{}'::jsonb) from (select form_code,max(sent_at) as last_sent from public.message_log where class_id=cid and student_id=st.id group by form_code) ml)
      ) order by st.urn)
      from public.students st join public.enrollments e on e.student_id=st.id where e.class_id=cid and not e.excluded and e.attendance_verified),'[]'::jsonb)
  ) into result;
  return result;
end;$$;

-- Registro do clique de envio no WhatsApp
create or replace function public.log_class_message(p_token text,p_urn text,p_code text) returns timestamptz
language plpgsql security definer set search_path to '' as $$
declare cid uuid;sid uuid;ts timestamptz;
begin
  select class_id into cid from public.class_links where token=p_token;
  if cid is null then raise exception 'Link inválido ou revogado'; end if;
  if p_code not in ('F3','F4','F5PRE','F5POS') then raise exception 'Invalid form code'; end if;
  select st.id into sid from public.students st join public.enrollments e on e.student_id=st.id where st.urn=p_urn and e.class_id=cid and not e.excluded and e.attendance_verified;
  if sid is null then raise exception 'Participante não encontrada'; end if;
  insert into public.message_log(class_id,student_id,form_code) values(cid,sid,p_code) returning sent_at into ts;
  return ts;
end;$$;

revoke execute on function public.share_class_link(uuid,boolean) from public,anon;
revoke execute on function public.revoke_class_link(uuid) from public,anon;
revoke execute on function public.get_class_board(text) from public;
revoke execute on function public.log_class_message(text,text,text) from public;
grant execute on function public.share_class_link(uuid,boolean) to authenticated;
grant execute on function public.revoke_class_link(uuid) to authenticated;
grant execute on function public.get_class_board(text) to anon,authenticated;
grant execute on function public.log_class_message(text,text,text) to anon,authenticated;
