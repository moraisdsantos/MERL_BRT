-- 010: configuração do painel; guarda o link da fonte de dados no Drive
-- (aplicada no sidp-merl como app_settings_drive)
create table if not exists public.app_settings(
  key text primary key check (key in ('drive_source_url')),
  value text not null default '' check (value='' or value ~ '^https://(drive|docs)\.google\.com/'),
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id)
);
alter table public.app_settings enable row level security;
drop policy if exists app_settings_admin on public.app_settings;
create policy app_settings_admin on public.app_settings for all to authenticated using (private.is_admin()) with check (private.is_admin());
grant select,insert,update on public.app_settings to authenticated;
insert into public.app_settings(key,value) values('drive_source_url','') on conflict do nothing;
