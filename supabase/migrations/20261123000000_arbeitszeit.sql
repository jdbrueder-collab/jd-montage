-- Zeiterfassung (Sammlung „arbeitszeit“): jeder Mitarbeiter sieht und schreibt nur seine eigenen Zeiten, Admins alle.
-- Alle übrigen Regeln bleiben exakt wie in 20261119000500_zugang.sql.
drop policy if exists docs_read on public.docs;
create policy docs_read on public.docs for select to authenticated using (
  is_owner()
  or (col in ('lohnsicht', 'anfragen') and id = auth.uid()::text)
  or (col = 'arbeitszeit' and is_member() and data->>'uid' = auth.uid()::text)
  or (col not in ('finanzen', 'mails', 'lohn', 'lohnsicht', 'anfragen', 'zugang', 'arbeitszeit') and is_member())
);

drop policy if exists docs_write on public.docs;
create policy docs_write on public.docs for all to authenticated using (
  is_owner()
  or (col = 'anfragen' and id = auth.uid()::text)
  or (col = 'arbeitszeit' and is_member() and data->>'uid' = auth.uid()::text)
  or (col not in ('finanzen', 'mails', 'lohn', 'lohnsicht', 'anfragen', 'zugang', 'arbeitszeit') and is_member())
) with check (
  is_owner()
  or (col = 'anfragen' and id = auth.uid()::text)
  or (col = 'arbeitszeit' and is_member() and data->>'uid' = auth.uid()::text)
  or (col not in ('finanzen', 'mails', 'lohn', 'lohnsicht', 'anfragen', 'zugang', 'arbeitszeit') and is_member())
);
