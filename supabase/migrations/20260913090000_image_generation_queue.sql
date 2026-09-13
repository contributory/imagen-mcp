create extension if not exists pgmq;

select pgmq.create('image_generation_jobs');

create table if not exists public.image_jobs (
  id uuid primary key,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  status text not null default 'queued' check (status in ('queued', 'processing', 'completed', 'failed')),
  request jsonb not null default '{}'::jsonb,
  result jsonb,
  error text,
  attempts integer not null default 0
);

alter table public.image_jobs enable row level security;
revoke all on table public.image_jobs from anon, authenticated;
grant select, insert, update, delete on table public.image_jobs to service_role;

create index if not exists image_jobs_status_updated_at_idx
  on public.image_jobs (status, updated_at desc);

create or replace function public.imagen_touch_image_job_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists imagen_touch_image_job_updated_at on public.image_jobs;
create trigger imagen_touch_image_job_updated_at
before update on public.image_jobs
for each row execute function public.imagen_touch_image_job_updated_at();

create or replace function public.imagen_enqueue_image_job(
  p_job_id uuid,
  p_request jsonb,
  p_payload jsonb
)
returns bigint
language plpgsql
security definer
set search_path = public, pgmq
as $$
declare
  v_msg_id bigint;
begin
  insert into public.image_jobs (id, status, request)
  values (p_job_id, 'queued', coalesce(p_request, '{}'::jsonb));

  select pgmq.send('image_generation_jobs', p_payload) into v_msg_id;
  return v_msg_id;
end;
$$;

create or replace function public.imagen_read_image_jobs(
  p_vt integer default 450,
  p_qty integer default 1
)
returns table (
  msg_id bigint,
  read_ct integer,
  enqueued_at timestamptz,
  vt timestamptz,
  message jsonb
)
language sql
security definer
set search_path = public, pgmq
as $$
  select r.msg_id, r.read_ct, r.enqueued_at, r.vt, r.message
  from pgmq.read('image_generation_jobs', greatest(p_vt, 1), greatest(p_qty, 1)) as r;
$$;

create or replace function public.imagen_delete_image_job_message(p_msg_id bigint)
returns boolean
language sql
security definer
set search_path = public, pgmq
as $$
  select pgmq.delete('image_generation_jobs', p_msg_id);
$$;

revoke all on function public.imagen_enqueue_image_job(uuid, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.imagen_read_image_jobs(integer, integer) from public, anon, authenticated;
revoke all on function public.imagen_delete_image_job_message(bigint) from public, anon, authenticated;

grant execute on function public.imagen_enqueue_image_job(uuid, jsonb, jsonb) to service_role;
grant execute on function public.imagen_read_image_jobs(integer, integer) to service_role;
grant execute on function public.imagen_delete_image_job_message(bigint) to service_role;
