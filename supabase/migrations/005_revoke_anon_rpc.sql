-- v5: contas sem login não chamam RPC alguma. As funções já bloqueiam por
-- is_admin()/vínculo, mas o padrão do Supabase concede EXECUTE ao anon na
-- criação; revogar fecha a superfície e silencia o advisor correspondente.
begin;
revoke execute on all functions in schema public from anon;
alter default privileges in schema public revoke execute on functions from anon;
commit;
