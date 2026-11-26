-- 012: categoria Safeguarding nos problemas. Menores de 18 anos não podem participar;
-- o registro é mantido e sinalizado, nunca apagado.
alter table public.issues drop constraint if exists issues_category_check;
alter table public.issues add constraint issues_category_check check (category in ('frequencia','chamada','urn','formulario','safeguarding','outra'));

do $m$ declare src text; n text;
begin
  src := pg_get_functiondef('public.sync_from_sheet(text,jsonb)'::regprocedure);
  n := replace(src, $b$when 'formulario' then 'formulario' else 'outra' end$b$, $b$when 'formulario' then 'formulario' when 'safeguarding' then 'safeguarding' else 'outra' end$b$);
  if n = src then raise exception 'mapeamento de categoria não encontrado'; end if;
  execute n;
end $m$;

update public.issues set category='safeguarding',
  recommendation='O projeto não admite menores de 18 anos. Os registros ficam na base, sinalizados como safeguarding, e não devem ser apagados. Confirmar a idade com a implementadora e não enviar formulários a essas pessoas até a confirmação.'
where title='Menores de 18 anos nas listas de frequência';

-- painel público da turma: quem tem sinal de safeguarding não recebe mensagem pelo link
do $m$ declare src text; n text;
begin
  src := pg_get_functiondef('public.get_class_board(text)'::regprocedure);
  n := replace(src, $b$'urn',st.urn,'phone',st.phone,$b$, $b$'urn',st.urn,'phone',st.phone,'safeguarding',exists(select 1 from unnest(e.attention) a where a ilike 'safeguarding%'),$b$);
  if n = src then raise exception 'trecho do painel não encontrado'; end if;
  execute n;
end $m$;
