-- Zugriff der angemeldeten Nutzer auf die Tabellen (was sie davon sehen, regeln die RLS-Regeln)
grant usage on schema public to authenticated;
grant select, insert, update, delete on public.docs to authenticated;
grant select, update on public.profiles to authenticated;
grant select on public.app_owner to authenticated;
grant execute on function public.doc_update(text, text, jsonb), public.is_owner(), public.is_member() to authenticated;
revoke all on public.docs, public.profiles, public.app_owner from anon;
