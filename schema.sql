-- FARZ / Farzon licensing & managers schema for Supabase (PostgreSQL)
-- Run migrations/001_managers_and_expiration.sql in Supabase SQL Editor for upgrades,
-- or run this full schema for a clean environment.

create extension if not exists pgcrypto;

create table if not exists public.admin (
  id uuid primary key default gen_random_uuid(),
  username text not null unique,
  password text not null,
  role varchar(50) not null default 'super_admin',
  is_active boolean not null default true,
  created_at timestamp with time zone not null default now()
);

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

create table if not exists public.activation_codes (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  is_active boolean not null default false,
  device_id text,
  is_blocked boolean not null default false,
  expires_at timestamp with time zone not null,
  created_at timestamp with time zone not null default now(),
  duration_days integer not null default 0,
  duration_label text not null default '',
  activated_at timestamp with time zone,
  last_seen_at timestamp with time zone,
  client_name varchar(255) not null default '',
  app_id varchar(50) not null default 'FARZ_V1',
  code_role varchar(30) not null default 'regular' check (code_role in ('regular', 'manager', 'manager_user')),
  manager_id uuid references public.managers(id) on delete restrict,
  created_by_admin_id uuid references public.admin(id) on delete set null,
  constraint activation_codes_role_manager_check check (
    (code_role = 'regular' and manager_id is null)
    or (code_role in ('manager', 'manager_user') and manager_id is not null and upper(app_id) in ('FARZ_V2', 'FARZON'))
  )
);

create index if not exists activation_codes_code_idx
  on public.activation_codes (code);

create index if not exists activation_codes_device_id_idx
  on public.activation_codes (device_id);

create index if not exists activation_codes_expires_at_idx
  on public.activation_codes (expires_at);

create index if not exists activation_codes_app_id_idx
  on public.activation_codes (app_id);

create unique index if not exists activation_codes_one_manager_code_idx
  on public.activation_codes (manager_id)
  where code_role = 'manager';

create index if not exists activation_codes_manager_role_idx
  on public.activation_codes (manager_id, code_role);

create index if not exists activation_codes_app_role_idx
  on public.activation_codes (app_id, code_role);

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

-- Atomic quota trigger & RPCs (see migrations/001_managers_and_expiration.sql for full upgrade script)
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
    select max_users into v_max_users from public.managers where id = new.manager_id for update;
    if not found then
      raise exception 'MANAGER_NOT_FOUND: manager does not exist';
    end if;
    select count(*) into v_current_count from public.activation_codes where manager_id = new.manager_id and code_role = 'manager_user';
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
  select max_users into v_max_users from public.managers where id = p_manager_id for update;
  if not found then
    raise exception 'MANAGER_NOT_FOUND: Manager % not found', p_manager_id;
  end if;
  select count(*) into v_current_count from public.activation_codes where manager_id = p_manager_id and code_role = 'manager_user';
  if (v_current_count + v_requested_count) > v_max_users then
    raise exception 'QUOTA_EXCEEDED: Requested % codes exceeds remaining quota (% remaining of %)',
      v_requested_count, greatest(0, v_max_users - v_current_count), v_max_users;
  end if;
  for v_item in select * from jsonb_array_elements(p_codes)
  loop
    insert into public.activation_codes (
      code, expires_at, duration_days, duration_label, client_name,
      app_id, code_role, manager_id, created_by_admin_id,
      is_active, is_blocked, device_id, activated_at, last_seen_at
    )
    values (
      upper(trim(v_item->>'code')),
      (v_item->>'expires_at')::timestamp with time zone,
      coalesce((v_item->>'duration_days')::integer, 30),
      coalesce(v_item->>'duration_label', ''),
      coalesce(trim(v_item->>'client_name'), ''),
      'FARZ_V2', 'manager_user', p_manager_id, p_created_by_admin_id,
      false, false, null, null, null
    )
    returning * into v_inserted;
    return next v_inserted;
  end loop;
  return;
end;
$$;

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
  select count(*) into v_current_count from public.activation_codes where manager_id = p_manager_id and code_role = 'manager_user';
  if p_new_max_users < v_current_count then
    raise exception 'QUOTA_BELOW_ISSUED: Cannot reduce quota to % because % user codes are already issued',
      p_new_max_users, v_current_count;
  end if;
  update public.managers set max_users = p_new_max_users, updated_at = now()
  where id = p_manager_id returning * into v_updated;
  return v_updated;
end;
$$;

alter table public.admin enable row level security;
alter table public.activation_codes enable row level security;
alter table public.managers enable row level security;
alter table public.manager_files enable row level security;

-- Note: After configuring SUPABASE_SERVICE_ROLE_KEY on Render, run migrations/002_rls_hardening.sql
drop policy if exists admin_server_access on public.admin;
create policy admin_server_access on public.admin for all to anon, authenticated using (true) with check (true);
drop policy if exists activation_codes_server_access on public.activation_codes;
create policy activation_codes_server_access on public.activation_codes for all to anon, authenticated using (true) with check (true);
drop policy if exists managers_server_access on public.managers;
create policy managers_server_access on public.managers for all to anon, authenticated using (true) with check (true);
drop policy if exists manager_files_server_access on public.manager_files;
create policy manager_files_server_access on public.manager_files for all to anon, authenticated using (true) with check (true);

grant select, insert, update, delete on table public.admin to anon, authenticated;
grant select, insert, update, delete on table public.activation_codes to anon, authenticated;
grant select, insert, update, delete on table public.managers to anon, authenticated;
grant select, insert, update, delete on table public.manager_files to anon, authenticated;
grant execute on function public.issue_manager_user_codes(uuid, jsonb, uuid) to anon, authenticated, service_role;
grant execute on function public.update_manager_quota(uuid, integer) to anon, authenticated, service_role;
