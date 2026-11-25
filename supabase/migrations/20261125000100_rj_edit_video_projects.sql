create or replace function public.rj_update_video_project(
  p_job_id uuid,
  p_topic text,
  p_story text,
  p_description text,
  p_aspect_ratio text,
  p_captions_enabled boolean
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then raise exception 'Authentication required'; end if;
  if p_topic is null or length(btrim(p_topic)) < 1 or length(p_topic) > 180 then
    raise exception 'Video title must be between 1 and 180 characters';
  end if;
  if p_story is null or length(p_story) > 50000 then
    raise exception 'Video script is too long';
  end if;
  if p_description is not null and length(p_description) > 5000 then
    raise exception 'Video description is too long';
  end if;
  if p_aspect_ratio not in ('16:9', '9:16', '1:1') then
    raise exception 'Unsupported video aspect ratio';
  end if;

  update public.jobs
  set input = coalesce(input, '{}'::jsonb) || jsonb_build_object('topic', btrim(p_topic), 'stage', 'story_ready', 'description', coalesce(p_description, ''), 'aspect_ratio', p_aspect_ratio, 'captions_enabled', coalesce(p_captions_enabled, true)),
      output = coalesce(output, '{}'::jsonb) || jsonb_build_object('story', p_story, 'stage', 'story_ready'),
      updated_at = now()
  where id = p_job_id
    and user_id = v_user_id
    and job_type = 'video_generation';

  if not found then raise exception 'Video project not found'; end if;
  return true;
end;
$$;

revoke all on function public.rj_update_video_project(uuid, text, text, text, text, boolean) from public, anon;
grant execute on function public.rj_update_video_project(uuid, text, text, text, text, boolean) to authenticated;
