do $$
declare
  v_job_id bigint;
begin
  for v_job_id in select jobid from cron.job where jobname = 'rj-worker-every-minute'
  loop
    perform cron.unschedule(v_job_id);
  end loop;
end;
$$;

select cron.schedule(
  'rj-worker-every-minute',
  '* * * * *',
  $job$
    select net.http_post(
      url := 'https://vxtklbtenozsluhseigp.supabase.co/functions/v1/rj-worker',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-rj-worker-token', (
          select decrypted_secret
          from vault.decrypted_secrets
          where name = 'rj_worker_cron_token'
        )
      ),
      body := jsonb_build_object('source', 'cron')
    );
  $job$
);
