create index if not exists schedules_job_id_idx on public.schedules(job_id);

alter policy "profiles_select_own" on public.profiles using ((select auth.uid()) = id);
alter policy "profiles_insert_own" on public.profiles with check ((select auth.uid()) = id);
alter policy "profiles_update_own" on public.profiles using ((select auth.uid()) = id) with check ((select auth.uid()) = id);

alter policy "settings_select_own" on public.user_settings using ((select auth.uid()) = user_id);
alter policy "settings_insert_own" on public.user_settings with check ((select auth.uid()) = user_id);
alter policy "settings_update_own" on public.user_settings using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
alter policy "settings_delete_own" on public.user_settings using ((select auth.uid()) = user_id);

alter policy "jobs_select_own" on public.jobs using ((select auth.uid()) = user_id);
alter policy "jobs_insert_own" on public.jobs with check ((select auth.uid()) = user_id);

alter policy "attempts_select_own_jobs" on public.job_attempts
using (exists (select 1 from public.jobs j where j.id = job_id and j.user_id = (select auth.uid())));

alter policy "schedules_select_own" on public.schedules using ((select auth.uid()) = user_id);
alter policy "schedules_insert_own" on public.schedules with check ((select auth.uid()) = user_id);
alter policy "schedules_update_own" on public.schedules using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
alter policy "schedules_delete_own" on public.schedules using ((select auth.uid()) = user_id);
