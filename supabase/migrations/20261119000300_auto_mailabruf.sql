-- Automatischer Mail-Abruf: ruft alle 15 Minuten die Server-Funktion „sync“ auf.
-- Das Geheimnis für den Aufruf wird hier in der Datenbank erzeugt (steht nirgends im Code).

create table if not exists public.app_secrets (name text primary key, value text not null);
alter table public.app_secrets enable row level security; -- keine Regeln = kein Zugriff aus der App
revoke all on public.app_secrets from anon, authenticated;
insert into public.app_secrets (name, value)
  values ('sync', replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''))
  on conflict (name) do nothing;

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- vorhandenen Plan ersetzen (falls die Migration erneut läuft)
select cron.unschedule(jobid) from cron.job where jobname = 'jd-mail-abruf';

select cron.schedule('jd-mail-abruf', '*/15 * * * *', $job$
  select net.http_post(
    url := 'https://glxnvjpoipcienngybmj.supabase.co/functions/v1/sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-sync-secret', (select value from public.app_secrets where name = 'sync')
    ),
    body := '{"quelle":"zeitplan"}'::jsonb,
    timeout_milliseconds := 2000
  );
$job$);
