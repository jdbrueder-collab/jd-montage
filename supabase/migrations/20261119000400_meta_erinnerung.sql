-- Morgendliche Erinnerungs-Mail an meta („bitte abholbereite Aufträge anklicken“).
-- Läuft stündlich an; die Funktion „sync“ sendet nur zur eingestellten Uhrzeit (deutsche Zeit),
-- nur wenn im Setup eingeschaltet und höchstens einmal pro Tag.
select cron.unschedule(jobid) from cron.job where jobname = 'jd-meta-erinnerung';

select cron.schedule('jd-meta-erinnerung', '0 * * * *', $job$
  select net.http_post(
    url := 'https://glxnvjpoipcienngybmj.supabase.co/functions/v1/sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-sync-secret', (select value from public.app_secrets where name = 'sync')
    ),
    body := '{"erinnerung":true}'::jsonb,
    timeout_milliseconds := 5000
  );
$job$);
