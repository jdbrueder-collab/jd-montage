-- Adressen, die bei ihrer ersten Anmeldung automatisch Admin werden
create table if not exists public.admin_emails (email text primary key);
alter table public.admin_emails enable row level security; -- kein Zugriff aus der App
insert into public.admin_emails values ('jd.brueder.meta@gmail.com') on conflict do nothing;

create or replace function public.on_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, name, email)
  values (new.id, coalesce(new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)), new.email)
  on conflict (id) do nothing;
  if exists (select 1 from admin_emails where email = lower(new.email)) then
    insert into public.app_owner (id) values (new.id) on conflict do nothing;
  end if;
  return new;
end $$;

-- falls die Adresse schon angemeldet ist
insert into public.app_owner (id)
  select u.id from auth.users u join admin_emails a on a.email = lower(u.email)
  on conflict do nothing;
