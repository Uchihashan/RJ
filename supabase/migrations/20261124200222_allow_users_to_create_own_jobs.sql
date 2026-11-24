create policy "jobs_insert_own" on public.jobs
for insert to authenticated
with check (auth.uid() = user_id);
