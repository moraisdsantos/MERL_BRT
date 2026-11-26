-- 014: linha marcada "Duplicado de <URN>" na planilha deixa de contar na turma (sem apagar o registro).
do $m$ declare src text; n text;
begin
  src := pg_get_functiondef('public.sync_from_sheet(text,jsonb)'::regprocedure);
  n := replace(src, $b$    n_part := n_part+1;$b$,
    $b$    if coalesce(private.txt(r->'Observações'),'') ~* 'duplicad[oa] de' then
      update public.enrollments en set excluded=true,
        exclusion_reason=case when en.excluded and en.exclusion_reason<>'' then en.exclusion_reason
          else coalesce(substring(private.txt(r->'Observações') from '(?i)(duplicad[oa] de [^;:]*)'),'Cadastro duplicado') end
      where en.student_id=sid and en.class_id=cid;
    end if;
    n_part := n_part+1;$b$);
  if n = src then raise exception 'trecho de participantes não encontrado'; end if;
  execute n;
end $m$;

-- linha sem nome na planilha (chamadas só com URN) não pode quebrar a sincronização
do $m$ declare src text; n text;
begin
  src := pg_get_functiondef('public.sync_from_sheet(text,jsonb)'::regprocedure);
  n := replace(src, $b$values(private.txt(r->'URN'),coalesce(private.txt(r->'Nome'),''),$b$, $b$values(private.txt(r->'URN'),coalesce(private.txt(r->'Nome'),private.txt(r->'URN')),$b$);
  n := replace(n, $b$on conflict(urn) do update set name=coalesce(nullif(excluded.name,''),public.students.name),$b$, $b$on conflict(urn) do update set name=coalesce(private.txt(r->'Nome'),public.students.name),$b$);
  if n = src then raise exception 'trecho de estudantes não encontrado'; end if;
  execute n;
end $m$;
