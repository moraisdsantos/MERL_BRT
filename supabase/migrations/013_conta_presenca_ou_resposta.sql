-- 013: conta na turma quem assinou a frequência OU respondeu algum formulário dela.
-- Inscrita sem assinatura e sem resposta não foi: fica fora do painel público da turma.
do $m$ declare src text; n text;
begin
  src := pg_get_functiondef('public.get_class_board(text)'::regprocedure);
  n := replace(src, $b$where e.class_id=cid and not e.excluded and e.attendance_verified)$b$,
    $b$where e.class_id=cid and not e.excluded and (e.attendance_verified or exists(select 1 from public.response_status rs where rs.student_id=st.id and rs.class_id=cid)))$b$);
  if n = src then raise exception 'filtro do painel não encontrado'; end if;
  execute n;
  src := pg_get_functiondef('public.log_class_message(text,text,text)'::regprocedure);
  n := replace(src, $b$and not e.excluded and e.attendance_verified$b$,
    $b$and not e.excluded and (e.attendance_verified or exists(select 1 from public.response_status rs where rs.student_id=st.id and rs.class_id=cid))$b$);
  if n <> src then execute n; end if;
end $m$;
