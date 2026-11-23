-- ============================================================================
-- Migration 001: Managers Groups, Independent Code Expiration & Manager Files
-- Target: Supabase (PostgreSQL) — Non-Destructive & Backward Compatible
-- ============================================================================
-- SAFETY GUARANTEES:
-- 1. Does NOT drop or delete any existing tables, codes, devices, or admins.
-- 2. All existing FARZ_V1 and FARZ_V2 codes automatically default to
--    code_role = 'regular' and manager_id = NULL without re-activation.
-- 3. Enforces manager user quotas atomically inside PostgreSQL (FOR UPDATE +
--    BEFORE INSERT trigger) to prevent race-condition quota bypasses.
-- ============================================================================

create extension if not exists pgcrypto;

-- ----------------------------------------------------------------------------
-- 1. Managers Table (Independent Manager Groups)
-- ----------------------------------------------------------------------------
create table if not exists public.managers (
  id uuid primary key default gen_random_uuid(),
  name varchar(255) not null,
  max_users integer not null default 10 check (max_users >= 0),
  is_active boolean not null default true,
  notes text not null default '',
  created_by_admin_id uuid references public.admin(id) on delete set null,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);

create index if not exists managers_is_active_idx
  on public.managers (is_active);

create index if not exists managers_created_at_idx
  on public.managers (created_at desc);

-- ----------------------------------------------------------------------------
-- 2. Extend activation_codes Non-Destructively
-- ----------------------------------------------------------------------------
alter table public.activation_codes
  add column if not exists code_role varchar(30) not null default 'regular';

alter table public.activation_codes
  add column if not exists manager_id uuid references public.managers(id) on delete restrict;

alter table public.activation_codes
  add column if not exists duration_days integer not null default 0;

-- Ensure legacy rows have valid defaults
update public.activation_codes
  set code_role = 'regular'
  where code_role is null or code_role = '';

-- Backfill approximate duration_days for legacy rows where duration_days = 0
update public.activation_codes
  set duration_days = greatest(1, round(extract(epoch from (expires_at - created_at)) / 86400.0)::integer)
  where duration_days = 0 and expires_at is not null and created_at is not null and expires_at > created_at;

-- Add role validation constraint safely
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'activation_codes_code_role_check'
  ) then
    alter table public.activation_codes
      add constraint activation_codes_code_role_check
      check (code_role in ('regular', 'manager', 'manager_user'));
  end if;
end $$;

-- Add role/manager consistency constraint safely
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'activation_codes_role_manager_check'
  ) then
    alter table public.activation_codes
      add constraint activation_codes_role_manager_check
      check (
        (code_role = 'regular' and manager_id is null)
        or (code_role in ('manager', 'manager_user') and manager_id is not null and upper(app_id) in ('FARZ_V2', 'FARZON'))
      );
  end if;
end $$;

-- Guarantee at most one manager code per manager group
create unique index if not exists activation_codes_one_manager_code_idx
  on public.activation_codes (manager_id)
  where code_role = 'manager';

create index if not exists activation_codes_manager_role_idx
  on public.activation_codes (manager_id, code_role);

create index if not exists activation_codes_app_role_idx
  on public.activation_codes (app_id, code_role);

-- ----------------------------------------------------------------------------
-- 3. Manager Files Table (Backed by Supabase Storage Private Bucket)
-- ----------------------------------------------------------------------------
create table if not exists public.manager_files (
  id uuid primary key default gen_random_uuid(),
  manager_id uuid not null references public.managers(id) on delete cascade,
  uploaded_by_code_id uuid references public.activation_codes(id) on delete set null,
  file_name text not null,
  file_size bigint not null default 0,
  records_count integer not null default 0,
  storage_bucket text not null default 'manager-files',
  storage_path text not null,
  file_hash text not null default '',
  version integer not null default 1,
  is_active boolean not null default true,
  deleted_at timestamp with time zone,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);

create index if not exists manager_files_manager_active_idx
  on public.manager_files (manager_id, is_active);

create index if not exists manager_files_created_at_idx
  on public.manager_files (created_at desc);

-- ----------------------------------------------------------------------------
-- 4. Database-Level Quota Enforcement Trigger (Prevents Direct Insert Bypass)
-- ----------------------------------------------------------------------------
create or replace function public.enforce_manager_user_quota()
returns trigger
language plpgsql
as $$
declare
  v_max_users integer;
  v_current_count integer;
begin
  if new.code_role = 'manager_user' then
    if new.manager_id is null then
      raise exception 'MANAGER_REQUIRED: manager_user code must reference a manager_id';
    end if;

    -- Lock the manager row to serialize concurrent insertions
    select max_users into v_max_users
    from public.managers
    where id = new.manager_id
    for update;

    if not found then
      raise exception 'MANAGER_NOT_FOUND: manager does not exist';
    end if;

    select count(*) into v_current_count
    from public.activation_codes
    where manager_id = new.manager_id
      and code_role = 'manager_user';

    if v_current_count >= v_max_users then
      raise exception 'QUOTA_EXCEEDED: Manager user quota (%) has been reached (current: %)', v_max_users, v_current_count;
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_enforce_manager_user_quota on public.activation_codes;
create trigger trg_enforce_manager_user_quota
  before insert on public.activation_codes
  for each row
  execute function public.enforce_manager_user_quota();

-- ----------------------------------------------------------------------------
-- 5. Atomic RPC: Issue Manager User Codes (Batch or Single, Quota-Safe)
-- ----------------------------------------------------------------------------
create or replace function public.issue_manager_user_codes(
  p_manager_id uuid,
  p_codes jsonb,
  p_created_by_admin_id uuid default null
)
returns setof public.activation_codes
language plpgsql
as $$
declare
  v_max_users integer;
  v_current_count integer;
  v_requested_count integer;
  v_item jsonb;
  v_inserted public.activation_codes%rowtype;
begin
  if p_codes is null or jsonb_typeof(p_codes) <> 'array' or jsonb_array_length(p_codes) = 0 then
    raise exception 'INVALID_CODES_PAYLOAD: p_codes must be a non-empty JSON array';
  end if;

  v_requested_count := jsonb_array_length(p_codes);

  select max_users into v_max_users
  from public.managers
  where id = p_manager_id
  for update;

  if not found then
    raise exception 'MANAGER_NOT_FOUND: Manager % not found', p_manager_id;
  end if;

  select count(*) into v_current_count
  from public.activation_codes
  where manager_id = p_manager_id
    and code_role = 'manager_user';

  if (v_current_count + v_requested_count) > v_max_users then
    raise exception 'QUOTA_EXCEEDED: Requested % codes exceeds remaining quota (% remaining of %)',
      v_requested_count, greatest(0, v_max_users - v_current_count), v_max_users;
  end if;

  for v_item in select * from jsonb_array_elements(p_codes)
  loop
    insert into public.activation_codes (
      code,
      expires_at,
      duration_days,
      duration_label,
      client_name,
      app_id,
      code_role,
      manager_id,
      created_by_admin_id,
      is_active,
      is_blocked,
      device_id,
      activated_at,
      last_seen_at
    )
    values (
      upper(trim(v_item->>'code')),
      (v_item->>'expires_at')::timestamp with time zone,
      coalesce((v_item->>'duration_days')::integer, 30),
      coalesce(v_item->>'duration_label', ''),
      coalesce(trim(v_item->>'client_name'), ''),
      'FARZ_V2',
      'manager_user',
      p_manager_id,
      p_created_by_admin_id,
      false,
      false,
      null,
      null,
      null
    )
    returning * into v_inserted;

    return next v_inserted;
  end loop;

  return;
end;
$$;

-- ----------------------------------------------------------------------------
-- 6. Atomic RPC: Update Manager Quota (Blocks Reduction Below Issued Count)
-- ----------------------------------------------------------------------------
create or replace function public.update_manager_quota(
  p_manager_id uuid,
  p_new_max_users integer
)
returns public.managers
language plpgsql
as $$
declare
  v_current_count integer;
  v_updated public.managers%rowtype;
begin
  if p_new_max_users is null or p_new_max_users < 0 then
    raise exception 'INVALID_QUOTA: max_users must be >= 0';
  end if;

  perform 1 from public.managers where id = p_manager_id for update;
  if not found then
    raise exception 'MANAGER_NOT_FOUND: Manager % not found', p_manager_id;
  end if;

  select count(*) into v_current_count
  from public.activation_codes
  where manager_id = p_manager_id
    and code_role = 'manager_user';

  if p_new_max_users < v_current_count then
    raise exception 'QUOTA_BELOW_ISSUED: Cannot reduce quota to % because % user codes are already issued',
      p_new_max_users, v_current_count;
  end if;

  update public.managers
  set max_users = p_new_max_users,
      updated_at = now()
  where id = p_manager_id
  returning * into v_updated;

  return v_updated;
end;
$$;

-- ----------------------------------------------------------------------------
-- 7. Compatibility RLS & Grants (Keep Existing Anon Key Working Until
--    Migration 002 RLS Hardening Is Applied With SUPABASE_SERVICE_ROLE_KEY)
-- ----------------------------------------------------------------------------
alter table public.managers enable row level security;
alter table public.manager_files enable row level security;

drop policy if exists managers_server_access on public.managers;
create policy managers_server_access
  on public.managers
  for all
  to anon, authenticated
  using (true)
  with check (true);

drop policy if exists manager_files_server_access on public.manager_files;
create policy manager_files_server_access
  on public.manager_files
  for all
  to anon, authenticated
  using (true)
  with check (true);

grant select, insert, update, delete on table public.managers to anon, authenticated;
grant select, insert, update, delete on table public.manager_files to anon, authenticated;
grant execute on function public.issue_manager_user_codes(uuid, jsonb, uuid) to anon, authenticated, service_role;
grant execute on function public.update_manager_quota(uuid, integer) to anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 8. Private Supabase Storage Bucket for Manager Files
-- ----------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'manager-files',
  'manager-files',
  false,
  52428800,
  array[
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-excel',
    'application/vnd.ms-excel.sheet.macroenabled.12',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.template',
    'application/vnd.ms-excel.template.macroenabled.12',
    'application/vnd.ms-excel.sheet.binary.macroenabled.12',
    'text/csv',
    'text/plain',
    'application/octet-stream'
  ]
)
on conflict (id) do update
set public = false,
    file_size_limit = 52428800;
