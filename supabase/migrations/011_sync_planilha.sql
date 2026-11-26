-- 011: a planilha "SIDP · Base MERL" no Drive é a fonte dos dados do painel.
-- O Apps Script da planilha chama public.sync_from_sheet com um segredo e o conteúdo das abas.

create table if not exists private.sync_config(
  id boolean primary key default true check (id),
  secret text not null
);
revoke all on private.sync_config from public, anon, authenticated;

alter table public.app_settings drop constraint if exists app_settings_key_check;
alter table public.app_settings add constraint app_settings_key_check check (key in ('drive_source_url','last_sync','last_sync_summary'));
alter table public.app_settings drop constraint if exists app_settings_value_check;
alter table public.app_settings add constraint app_settings_value_check check (key<>'drive_source_url' or value='' or value ~ '^https://(drive|docs)\.google\.com/');

-- Texto livre da planilha: tira espaços nas pontas; vazio vira null.
create or replace function private.txt(v jsonb) returns text language sql immutable as $$
  select nullif(btrim(case when v is null or jsonb_typeof(v)='null' then '' when jsonb_typeof(v)='string' then v#>>'{}' else v::text end),'')
$$;

create or replace function private.plain(v text) returns text language sql immutable as $$
  select lower(translate(coalesce(v,''),'áàâãäéèêëíìîïóòôõöúùûüçÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ','aaaaaeeeeiiiiooooouuuucAAAAAEEEEIIIIOOOOOUUUUC'))
$$;

-- URN digitada de qualquer jeito ("LB100003", "L-B9:0061", "L, b9-0055") -> participante única com aquela usina e número.
create or replace function private.match_typed_urn(p_typed text) returns table(student_id uuid, class_id uuid)
language plpgsql stable security definer set search_path='' as $$
declare d text; k int; hits int;
begin
  d := regexp_replace(upper(coalesce(substring(upper(p_typed) from 'B(.*)$'),'')),'[^0-9]','','g');
  if length(d) < 3 then return; end if;
  for k in 1..2 loop
    if length(d) <= k then continue; end if;
    return query
      select e.student_id, e.class_id
      from public.students s join public.enrollments e on e.student_id=s.id and not e.excluded
      where s.urn ~ '^L-B[0-9]+-[0-9]+$'
        and (regexp_match(s.urn,'^L-B([0-9]+)-([0-9]+)$'))[1]::int = left(d,k)::int
        and (regexp_match(s.urn,'^L-B([0-9]+)-([0-9]+)$'))[2]::int = substr(d,k+1)::int;
    get diagnostics hits = row_count;
    if hits > 0 then return; end if;
  end loop;
end;$$;

create or replace function public.sync_from_sheet(p_secret text, p_payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  r jsonb; v jsonb; fcode text; cid uuid; sid uuid; n_turmas int:=0; n_part int:=0; n_forms int:=0; n_ignoradas int:=0; n_prob int:=0;
  novos jsonb:='[]'::jsonb; start_date date; end_date date; first_class date; ext text; typed text; st text; origin text; reason text; fl text[];
  prior public.form4_submissions; admin_id uuid; summary jsonb;
begin
  if p_secret is null or p_secret is distinct from (select secret from private.sync_config) then
    raise exception 'Sincronização recusada: segredo inválido' using errcode='42501';
  end if;
  select id into admin_id from public.profiles where role='admin' order by email limit 1;

  -- Formulários: nome e link valem para todas as turmas
  for r in select value from jsonb_array_elements(coalesce(p_payload->'formularios','[]')) loop
    fcode := upper(private.txt(r->'Código'));
    if fcode in ('F3','F4','F5PRE','F5POS') then
      update public.surveys set name=coalesce(private.txt(r->'Nome na implementação'),name),
        url=case when private.txt(r->'Link') ~ '^https://' then private.txt(r->'Link') else url end
      where surveys.code=fcode;
    end if;
  end loop;

  -- Turmas
  for r in select value from jsonb_array_elements(coalesce(p_payload->'turmas','[]')) loop
    fcode := upper(private.txt(r->'ID turma'));
    if fcode is null then continue; end if;
    start_date := private.txt(r->'Início das aulas')::date; end_date := private.txt(r->'Fim das aulas')::date;
    if start_date is null or end_date is null then continue; end if;
    insert into public.classes(code,name,partner,starts_on,ends_on,followup_on,shift,level,management_imported,management_source)
    values(fcode,coalesce(private.txt(r->'Usina da Paz'),fcode),'',start_date,end_date,end_date+21,coalesce(private.txt(r->'Turno'),''),
      case when private.plain(private.txt(r->'Nível')) like 'intermedi%' then 'Intermediário' else 'Básico' end,true,jsonb_build_object('fonte','planilha'))
    on conflict(code) do update set name=excluded.name,starts_on=excluded.starts_on,ends_on=excluded.ends_on,followup_on=excluded.followup_on,shift=excluded.shift,level=excluded.level
    returning id into cid;
    -- os quatro formulários existem para toda turma, com o prazo de cada um
    insert into public.surveys(class_id,code,name,url,due_date,message_template)
    select cid,x.code,coalesce(t.name,x.code),coalesce(t.url,''),
      case x.code when 'F4' then end_date+21 when 'F5PRE' then start_date else end_date end,
      coalesce(t.message_template,'Olá! Aqui é a equipe do projeto SIDP. Pedimos que você responda ao formulário pelo link: {link}'||chr(10)||chr(10)||'Matrícula: {matricula}'||chr(10)||'Obrigado!'||chr(10)||'Equipe MERL · ARCA')
    from (values('F3'),('F4'),('F5PRE'),('F5POS')) x(code)
    left join lateral (select s.name,s.url,s.message_template from public.surveys s where s.code=x.code order by s.url desc limit 1) t on true
    on conflict(class_id,code) do update set due_date=excluded.due_date;
    n_turmas := n_turmas+1;
  end loop;

  -- Participantes (uma linha por pessoa em cada turma)
  for r in select value from jsonb_array_elements(coalesce(p_payload->'participantes','[]')) loop
    if private.txt(r->'URN') is null or private.txt(r->'ID turma') is null then continue; end if;
    select id into cid from public.classes where classes.code=upper(private.txt(r->'ID turma'));
    if cid is null then continue; end if;
    insert into public.students(urn,name,phone) values(private.txt(r->'URN'),coalesce(private.txt(r->'Nome'),''),coalesce(regexp_replace(private.txt(r->'Telefone'),'[^0-9]','','g'),''))
    on conflict(urn) do update set name=coalesce(nullif(excluded.name,''),public.students.name),phone=excluded.phone
    returning id into sid;
    insert into public.enrollments(student_id,class_id,attendance_verified,attention)
    values(sid,cid,private.plain(private.txt(r->'Presença confirmada')) in ('sim','s','yes','x'),
      coalesce(array(select btrim(x) from unnest(string_to_array(private.txt(r->'Observações'),';')) x where btrim(x)<>''),'{}'))
    on conflict(student_id,class_id) do update set attendance_verified=excluded.attendance_verified,attention=excluded.attention;
    n_part := n_part+1;
  end loop;

  -- Respostas dos formulários (dataset do Kobo colado nas abas)
  select min(starts_on) into first_class from public.classes;
  for fcode in select jsonb_object_keys(coalesce(p_payload->'forms','{}')) loop
    if fcode not in ('F3','F4','F5PRE','F5POS') then continue; end if;
    for r in select value from jsonb_array_elements(p_payload->'forms'->fcode) loop
      ext := coalesce(private.txt(r->'_uuid'),replace(private.txt(r->'meta/instanceID'),'uuid:',''));
      if ext is null then continue; end if;
      -- só Brasil, e só a partir da primeira turma (testes e outros países ficam de fora)
      if coalesce(private.txt(r->'main_survey/A3aiv_Region_Province_in_Brazil'),'n/a')='n/a'
         or private.txt(r->'_submission_time') is null
         or (first_class is not null and (private.txt(r->'_submission_time'))::timestamptz < first_class - 1) then
        n_ignoradas := n_ignoradas+1; continue;
      end if;
      typed := coalesce(private.txt(r->'main_survey/A1_Please_enter_you_stration_Number_URN'),'');
      select * into prior from public.form4_submissions where external_id=ext;
      v := (select value from jsonb_array_elements(coalesce(p_payload->'vinculos','[]')) value where private.txt(value->'ID da resposta')=ext limit 1);
      sid := null; cid := null; st := 'review'; origin := 'auto'; reason := ''; fl := '{}';
      if v is not null then
        reason := coalesce(private.txt(v->'Motivo'),'');
        origin := case when reason<>'' or prior.match_origin='manual' then 'manual' else 'auto' end;
        case private.plain(private.txt(v->'Situação'))
          when 'ignorada' then st := 'ignored';
          when 'em revisao' then st := 'review'; fl := case when reason<>'' then array[reason] else coalesce(prior.flags,'{}') end;
          else
            select s.id into sid from public.students s where s.urn=private.txt(v->'URN');
            select c.id into cid from public.classes c where c.code=upper(private.txt(v->'ID turma'));
            if sid is not null and cid is not null and exists(select 1 from public.enrollments e where e.student_id=sid and e.class_id=cid) then st := 'linked'; fl := coalesce(prior.flags,'{}');
            else sid := null; cid := null; st := 'review'; fl := array['Vínculo da planilha não encontrado no cadastro']; end if;
        end case;
        if reason='' then reason := coalesce(prior.review_reason,''); end if;
      elsif prior.id is not null and prior.match_origin='manual' then
        sid := prior.student_id; cid := prior.class_id; st := prior.state; origin := 'manual'; reason := prior.review_reason; fl := prior.flags;
      else
        select m.student_id, m.class_id into sid, cid from private.match_typed_urn(typed) m;
        if (select count(*) from private.match_typed_urn(typed)) = 1 then st := 'linked';
        else sid := null; cid := null; st := 'review'; fl := array['URN não reconhecida; vincular na aba Vínculos']; end if;
      end if;
      insert into public.form4_submissions(external_id,form_code,source_urn,source_name,source_phone,country,submitted_at,student_id,class_id,state,flags,candidates,answers,match_origin,review_reason)
      values(ext,fcode,typed,coalesce(private.txt(r->'main_survey/A2_Please_enter_your_name'),''),coalesce(private.txt(r->'phonenumber'),''),
        coalesce(private.txt(r->'main_survey/A3_Country'),''),(private.txt(r->'_submission_time'))::timestamptz,sid,cid,st,fl,'[]',
        (select coalesce(jsonb_object_agg(k,val),'{}') from jsonb_each(r) e(k,val) where private.txt(val) is not null),origin,reason)
      on conflict(external_id) do update set form_code=excluded.form_code,source_urn=excluded.source_urn,source_name=excluded.source_name,source_phone=excluded.source_phone,
        country=excluded.country,submitted_at=excluded.submitted_at,student_id=excluded.student_id,class_id=excluded.class_id,state=excluded.state,flags=excluded.flags,
        answers=excluded.answers,match_origin=excluded.match_origin,review_reason=excluded.review_reason,updated_at=now();
      n_forms := n_forms+1;
    end loop;
  end loop;
  -- recalcula o status de quem estava ou ficou vinculado
  perform private.refresh_submission(p.student_id,p.class_id,p.code) from (
    select rs.student_id, rs.class_id, s.code from public.response_status rs join public.surveys s on s.id=rs.survey_id
    union select student_id, class_id, form_code from public.form4_submissions where state='linked' and student_id is not null) p;
  perform private.refresh_review_flags();

  -- Problemas: linhas sem ID são novas; o ID volta para a planilha
  for r in select value from jsonb_array_elements(coalesce(p_payload->'problemas','[]')) loop
    if private.txt(r->'Título') is null then continue; end if;
    if private.txt(r->'ID') ~ '^[0-9a-f-]{36}$' and exists(select 1 from public.issues where id=private.txt(r->'ID')::uuid) then
      update public.issues set
        category=case private.plain(private.txt(r->'Categoria')) when 'frequencia' then 'frequencia' when 'chamada' then 'chamada' when 'urn' then 'urn' when 'formulario' then 'formulario' else 'outra' end,
        title=private.txt(r->'Título'),detail=coalesce(private.txt(r->'Detalhe'),''),recommendation=coalesce(private.txt(r->'Recomendação'),''),
        class_ids=coalesce((select array_agg(c.id) from public.classes c where c.code = any(string_to_array(upper(replace(coalesce(private.txt(r->'Turmas'),''),' ','')),','))),'{}'),
        status=case when private.plain(private.txt(r->'Situação'))='resolvida' then 'resolvida' else 'aberta' end,
        resolved_at=case when private.plain(private.txt(r->'Situação'))='resolvida' then coalesce(resolved_at,now()) end,
        resolution_note=coalesce(private.txt(r->'Nota de resolução'),'')
      where id=private.txt(r->'ID')::uuid;
    else
      insert into public.issues(category,title,detail,recommendation,class_ids,status,resolved_at,resolution_note,created_by)
      values(case private.plain(private.txt(r->'Categoria')) when 'frequencia' then 'frequencia' when 'chamada' then 'chamada' when 'urn' then 'urn' when 'formulario' then 'formulario' else 'outra' end,
        private.txt(r->'Título'),coalesce(private.txt(r->'Detalhe'),''),coalesce(private.txt(r->'Recomendação'),''),
        coalesce((select array_agg(c.id) from public.classes c where c.code = any(string_to_array(upper(replace(coalesce(private.txt(r->'Turmas'),''),' ','')),','))),'{}'),
        case when private.plain(private.txt(r->'Situação'))='resolvida' then 'resolvida' else 'aberta' end,
        case when private.plain(private.txt(r->'Situação'))='resolvida' then now() end,coalesce(private.txt(r->'Nota de resolução'),''),admin_id)
      returning to_jsonb(id) into v;
      novos := novos || jsonb_build_array(jsonb_build_object('linha',(r->>'_linha')::int,'id',v#>>'{}'));
    end if;
    n_prob := n_prob+1;
  end loop;

  summary := jsonb_build_object('turmas',n_turmas,'participantes',n_part,'respostas',n_forms,'respostas_ignoradas',n_ignoradas,'problemas',n_prob,
    'em_revisao',(select count(*) from public.form4_submissions where state='review'),'problemas_novos',novos);
  insert into public.app_settings(key,value,updated_at) values('last_sync',now()::text,now()) on conflict(key) do update set value=excluded.value,updated_at=now();
  insert into public.app_settings(key,value,updated_at) values('last_sync_summary',(summary-'problemas_novos')::text,now()) on conflict(key) do update set value=excluded.value,updated_at=now();
  return summary;
end;$$;

revoke execute on function public.sync_from_sheet(text,jsonb) from public;
grant execute on function public.sync_from_sheet(text,jsonb) to anon, authenticated;
revoke execute on function private.match_typed_urn(text) from public, anon, authenticated;
