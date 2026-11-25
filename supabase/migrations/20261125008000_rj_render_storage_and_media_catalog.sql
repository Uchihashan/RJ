-- RJ private rendered media storage and current image/video provider policy.
-- Feature branch only. Do not apply to hosted Supabase without explicit approval.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'rj-renders',
  'rj-renders',
  false,
  471859200,
  array['video/mp4','image/jpeg','application/x-subrip']
)
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Users can view their own RJ rendered media" on storage.objects;
create policy "Users can view their own RJ rendered media"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'rj-renders'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

insert into public.provider_capability_catalog
  (provider_key, capability, model_key, output_formats, pricing_mode, availability, notes)
values
  ('gemini_image','image','gemini-3.1-flash-lite-image',array['image/png','image/jpeg'],'paid','disabled_by_policy',
   'Official Gemini image model. No free tier is listed. Disabled; do not call until explicit paid-use consent and hard spend enforcement are implemented.'),
  ('gemini_video','video','gemini-omni-1.1-flash',array['video/mp4'],'paid','disabled_by_policy',
   'Official Gemini Omni Flash video generation is paid-tier only (approximately USD 0.10 per second of 720p output on the current pricing page). Disabled by policy.'),
  ('ffmpeg','media_assembly','ffmpeg',array['video/mp4'],'free_route','available',
   'Open-source local media assembly. Compute and storage hosting may still incur infrastructure charges.'),
  ('ffmpeg','render','ffmpeg-h264',array['video/mp4'],'free_route','available',
   'Open-source H.264 renderer. Compute and storage hosting may still incur infrastructure charges.')
on conflict (provider_key, capability, model_key) do update set
  output_formats = excluded.output_formats,
  pricing_mode = excluded.pricing_mode,
  availability = excluded.availability,
  notes = excluded.notes,
  updated_at = now();

comment on bucket storage.buckets is 'RJ render outputs are private and stored under {user_id}/{job_id}/ paths.';
