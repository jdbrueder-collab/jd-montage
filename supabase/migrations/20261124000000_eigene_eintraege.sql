-- Jeder sieht nur seine eigenen Fotos und Reklamationen, die Chefs sehen alles.
--   fotos:          Chefs alles · meta (Hersteller) lesen wie bisher · Unterlagen alle · sonst nur eigene (data.von)
--   reklamationen:  Chefs und meta alles · sonst nur eigene
--   Speicher:       Bilddateien fremder Fotos/Reklamationen sind für Mitarbeiter und Subs gesperrt
-- Alle übrigen Regeln bleiben exakt wie in 20261123000000_arbeitszeit.sql.

create or replace function public.meine_rolle() returns text
language sql stable security definer set search_path = public as $$
  select data->'map'->>auth.uid()::text from docs where col = 'einstellungen' and id = 'rollen';
$$;

create or replace function public.is_chef() returns boolean
language sql stable security definer set search_path = public as $$
  select is_owner() or coalesce(meine_rolle() = 'chef', false);
$$;

-- Gehört die Datei zu einem Foto oder einer Reklamation von jemand anderem? (läuft ohne RLS, damit die Prüfung alles sieht)
create or replace function public.asset_fremd(p_name text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from docs d
    where d.col = 'fotos' and d.data->>'assetId' = p_name
      and coalesce(d.data->>'kat', '') <> 'unterlagen'
      and coalesce(d.data->>'von', '') <> coalesce(auth.uid()::text, '')
  ) or exists (
    select 1 from docs d
    where d.col = 'reklamationen' and jsonb_typeof(d.data->'fotos') = 'array' and d.data->'fotos' ? p_name
      and coalesce(d.data->>'von', '') <> coalesce(auth.uid()::text, '')
  );
$$;

create index if not exists docs_fotos_asset on public.docs ((data->>'assetId')) where col = 'fotos';

drop policy if exists docs_read on public.docs;
create policy docs_read on public.docs for select to authenticated using (
  is_owner()
  or (col in ('lohnsicht', 'anfragen') and id = auth.uid()::text)
  or (col = 'arbeitszeit' and is_member() and data->>'uid' = auth.uid()::text)
  or (col = 'fotos' and is_member() and (is_chef() or meine_rolle() = 'hersteller' or data->>'kat' = 'unterlagen' or data->>'von' = auth.uid()::text))
  or (col = 'reklamationen' and is_member() and (is_chef() or meine_rolle() = 'hersteller' or data->>'von' = auth.uid()::text))
  or (col not in ('finanzen', 'mails', 'lohn', 'lohnsicht', 'anfragen', 'zugang', 'arbeitszeit', 'fotos', 'reklamationen') and is_member())
);

drop policy if exists docs_write on public.docs;
create policy docs_write on public.docs for all to authenticated using (
  is_owner()
  or (col = 'anfragen' and id = auth.uid()::text)
  or (col = 'arbeitszeit' and is_member() and data->>'uid' = auth.uid()::text)
  or (col = 'fotos' and is_member() and (is_chef() or data->>'von' = auth.uid()::text))
  or (col = 'reklamationen' and is_member() and (is_chef() or meine_rolle() = 'hersteller' or data->>'von' = auth.uid()::text))
  or (col not in ('finanzen', 'mails', 'lohn', 'lohnsicht', 'anfragen', 'zugang', 'arbeitszeit', 'fotos', 'reklamationen') and is_member())
) with check (
  is_owner()
  or (col = 'anfragen' and id = auth.uid()::text)
  or (col = 'arbeitszeit' and is_member() and data->>'uid' = auth.uid()::text)
  or (col = 'fotos' and is_member() and (is_chef() or data->>'von' = auth.uid()::text))
  or (col = 'reklamationen' and is_member() and (is_chef() or meine_rolle() = 'hersteller' or data->>'von' = auth.uid()::text))
  or (col not in ('finanzen', 'mails', 'lohn', 'lohnsicht', 'anfragen', 'zugang', 'arbeitszeit', 'fotos', 'reklamationen') and is_member())
);

-- Speicher: lesen nur, was nicht zu fremden Fotos/Reklamationen gehört; ändern/löschen nur eigene Dateien (Chefs alles)
drop policy if exists assets_rw on storage.objects;
drop policy if exists assets_read on storage.objects;
drop policy if exists assets_insert on storage.objects;
drop policy if exists assets_change on storage.objects;
drop policy if exists assets_delete on storage.objects;
create policy assets_read on storage.objects for select to authenticated
  using (bucket_id = 'assets' and public.is_member()
         and (public.is_chef() or public.meine_rolle() = 'hersteller' or owner_id = auth.uid()::text or not public.asset_fremd(name)));
create policy assets_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'assets' and public.is_member());
create policy assets_change on storage.objects for update to authenticated
  using (bucket_id = 'assets' and public.is_member() and (public.is_chef() or owner_id = auth.uid()::text))
  with check (bucket_id = 'assets' and public.is_member());
create policy assets_delete on storage.objects for delete to authenticated
  using (bucket_id = 'assets' and public.is_member() and (public.is_chef() or owner_id = auth.uid()::text));
