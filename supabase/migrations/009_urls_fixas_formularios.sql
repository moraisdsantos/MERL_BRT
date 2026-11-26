-- 009: URLs fixas dos formulários (Enketo/Ona) e nomes usados na implementação
-- (aplicada no sidp-merl como urls_fixas_formularios)
-- Form 3  https://enketo.ona.io/x/gJtcNBrz  Cadastro e Pesquisa de Linha de Base (Básico, antes do início)
-- Form 5  https://enketo.ona.io/x/On9V6YHY  Avaliação Pré-Treinamento (Intermediário, início)
-- Form 5  https://enketo.ona.io/x/fxKLAhYL  Avaliação Pós-Treinamento (Intermediário, final)
-- Form 4  https://enketo.ona.io/x/KwpHp6iz  Pesquisa de Fim de Projeto (todas, 3 semanas após)
update public.surveys set url='https://enketo.ona.io/x/gJtcNBrz', name='Cadastro e Pesquisa de Linha de Base' where code='F3';
update public.surveys set url='https://enketo.ona.io/x/On9V6YHY', name='Avaliação Pré-Treinamento' where code='F5PRE';
update public.surveys set url='https://enketo.ona.io/x/fxKLAhYL', name='Avaliação Pós-Treinamento' where code='F5POS';
update public.surveys set url=coalesce(nullif(url,''),'https://enketo.ona.io/x/KwpHp6iz'), name='Pesquisa de Fim de Projeto' where code='F4';

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
    values(cid,'F4','Pesquisa de Fim de Projeto',case when r->>'url' ~ '^https://' then r->>'url' else 'https://enketo.ona.io/x/KwpHp6iz' end,end_date+21,E'Olá! Aqui é a equipe do projeto SIDP. Sua turma {turma} encerrou há três semanas. Você pode responder ao Form 4 pelo link: {link}\n\nMatrícula: {matricula}\nObrigado!\nEquipe MERL · ARCA')
    on conflict(class_id,code) do update set due_date=excluded.due_date,url=coalesce(nullif(excluded.url,''),public.surveys.url);
    insert into public.surveys(class_id,code,name,url,due_date,message_template)
    values(cid,'F3','Cadastro e Pesquisa de Linha de Base','https://enketo.ona.io/x/gJtcNBrz',end_date,E'Olá! Aqui é a equipe do projeto SIDP. Durante as aulas da turma {turma}, pedimos que você responda ao Form 3 pelo link: {link}\n\nMatrícula: {matricula}\nObrigado!\nEquipe MERL · ARCA')
    on conflict(class_id,code) do update set due_date=excluded.due_date;
    insert into public.surveys(class_id,code,name,url,due_date,message_template)
    values(cid,'F5PRE','Avaliação Pré-Treinamento','https://enketo.ona.io/x/On9V6YHY',start_date,E'Olá! Aqui é a equipe do projeto SIDP. Antes da primeira aula da turma {turma}, pedimos que você responda ao Form 5 pelo link: {link}\n\nMatrícula: {matricula}\nObrigado!\nEquipe MERL · ARCA')
    on conflict(class_id,code) do update set due_date=excluded.due_date;
    insert into public.surveys(class_id,code,name,url,due_date,message_template)
    values(cid,'F5POS','Avaliação Pós-Treinamento','https://enketo.ona.io/x/fxKLAhYL',end_date,E'Olá! Aqui é a equipe do projeto SIDP. Na última aula da turma {turma}, pedimos que você responda ao Form 5 pelo link: {link}\n\nMatrícula: {matricula}\nObrigado!\nEquipe MERL · ARCA')
    on conflict(class_id,code) do update set due_date=excluded.due_date;
    n:=n+1;
    perform private.refresh_submission(f.student_id,cid,f.form_code) from (select distinct student_id,form_code from public.form4_submissions where class_id=cid and state='linked') f;
  end loop;
  insert into public.source_imports(kind,filename,imported_by,row_count,payload) values('management',p_filename,auth.uid(),n,p_rows);
  return n;
end;
$function$;
