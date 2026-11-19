-- JD Brüder Montage: Datenbank für Supabase
-- Bildet die Dokument-Datenbank der Claude-Version nach: jede Sammlung/Dokument ist eine Zeile.
-- Einmal im Supabase SQL Editor ausführen.

create table if not exists public.docs (
  col  text not null,
  id   text not null,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (col, id)
);
alter table public.docs replica identity full; -- Realtime liefert bei Löschungen die ganze Zeile

create table if not exists public.profiles (
  id    uuid primary key references auth.users on delete cascade,
  name  text,
  email text
);

-- Admin (Chef). Erster Eintrag per Hand: insert into app_owner select id from auth.users where email = '...';
create table if not exists public.app_owner (
  id uuid primary key references auth.users on delete cascade
);

-- Profil automatisch beim ersten Login anlegen
create or replace function public.on_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, name, email)
  values (new.id, coalesce(new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)), new.email)
  on conflict (id) do nothing;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.on_new_user();

-- Rollen-Helfer
create or replace function public.is_owner() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from app_owner where id = auth.uid());
$$;

create or replace function public.is_member() returns boolean
language sql stable security definer set search_path = public as $$
  select is_owner() or exists (
    select 1 from docs
    where col = 'einstellungen' and id = 'rollen'
      and data->'map' ? auth.uid()::text
  );
$$;

-- Nur Chef: finanzen, mails, lohn. Pro Person: lohnsicht/<uid>, anfragen/<uid>. Rest: freigegebene Nutzer.
alter table public.docs enable row level security;

drop policy if exists docs_read on public.docs;
create policy docs_read on public.docs for select to authenticated using (
  is_owner()
  or (col in ('lohnsicht', 'anfragen') and id = auth.uid()::text)
  or (col not in ('finanzen', 'mails', 'lohn', 'lohnsicht', 'anfragen') and is_member())
);

drop policy if exists docs_write on public.docs;
create policy docs_write on public.docs for all to authenticated using (
  is_owner()
  or (col = 'anfragen' and id = auth.uid()::text)
  or (col not in ('finanzen', 'mails', 'lohn', 'lohnsicht', 'anfragen') and is_member())
) with check (
  is_owner()
  or (col = 'anfragen' and id = auth.uid()::text)
  or (col not in ('finanzen', 'mails', 'lohn', 'lohnsicht', 'anfragen') and is_member())
);

alter table public.profiles enable row level security;
drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles for select to authenticated using (true);
drop policy if exists profiles_self on public.profiles;
create policy profiles_self on public.profiles for update to authenticated using (id = auth.uid());

alter table public.app_owner enable row level security;
drop policy if exists owner_read on public.app_owner;
create policy owner_read on public.app_owner for select to authenticated using (true);

-- Teil-Update wie in der Claude-Version: Felder zusammenführen statt ersetzen (RLS gilt, security invoker)
create or replace function public.doc_update(p_col text, p_id text, p_patch jsonb) returns void
language sql security invoker set search_path = public as $$
  insert into docs (col, id, data) values (p_col, p_id, p_patch)
  on conflict (col, id) do update set data = docs.data || excluded.data, updated_at = now();
$$;

-- Live-Updates
do $$ begin
  alter publication supabase_realtime add table public.docs;
exception when duplicate_object then null; end $$;

-- Fotos, Unterschriften, PDFs: privater Speicher, nur freigegebene Nutzer
insert into storage.buckets (id, name, public) values ('assets', 'assets', false)
  on conflict (id) do nothing;

drop policy if exists assets_rw on storage.objects;
create policy assets_rw on storage.objects for all to authenticated
  using (bucket_id = 'assets' and public.is_member())
  with check (bucket_id = 'assets' and public.is_member());
