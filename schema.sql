-- FARZ licensing schema for Supabase (PostgreSQL)
-- Run this in the Supabase SQL Editor if you are not applying it via migration.

create extension if not exists pgcrypto;

create table if not exists public.admin (
  id uuid primary key default gen_random_uuid(),
  username text not null unique,
  password text not null,
  created_at timestamp with time zone not null default now()
);

create table if not exists public.activation_codes (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  is_active boolean not null default true,
  device_id text,
  is_blocked boolean not null default false,
  expires_at timestamp with time zone not null,
  created_at timestamp with time zone not null default now(),
  duration_label text not null default '',
  activated_at timestamp with time zone,
  last_seen_at timestamp with time zone,
  client_name varchar(255) not null default '',
  app_id varchar(50) not null default 'FARZ_V1'
);

create index if not exists activation_codes_code_idx
  on public.activation_codes (code);

create index if not exists activation_codes_device_id_idx
  on public.activation_codes (device_id);

create index if not exists activation_codes_expires_at_idx
  on public.activation_codes (expires_at);

create index if not exists activation_codes_app_id_idx
  on public.activation_codes (app_id);

alter table public.admin enable row level security;
alter table public.activation_codes enable row level security;

drop policy if exists admin_server_access on public.admin;
create policy admin_server_access
  on public.admin
  for all
  to anon, authenticated
  using (true)
  with check (true);

drop policy if exists activation_codes_server_access on public.activation_codes;
create policy activation_codes_server_access
  on public.activation_codes
  for all
  to anon, authenticated
  using (true)
  with check (true);

grant select, insert, update, delete on table public.admin to anon, authenticated;
grant select, insert, update, delete on table public.activation_codes to anon, authenticated;

alter table public.activation_codes
  add column if not exists client_name varchar(255) default '';

alter table public.activation_codes
  add column if not exists app_id varchar(50) default 'FARZ_V1';

update public.activation_codes
  set app_id = 'FARZ_V1'
  where app_id is null or app_id = '';

-- ==========================================
-- Super Admin / Sub-Admin & Quota Upgrade
-- ==========================================
alter table public.admin
  add column if not exists role varchar(50) default 'super_admin',
  add column if not exists max_codes_quota int default 0,
  add column if not exists is_active boolean default true,
  add column if not exists created_by uuid references public.admin(id);

alter table public.activation_codes
  add column if not exists created_by_admin_id uuid references public.admin(id);

create index if not exists activation_codes_created_by_admin_id_idx
  on public.activation_codes (created_by_admin_id);

-- Set existing legacy codes as owned by the default super admin
update public.activation_codes
  set created_by_admin_id = (select id from public.admin order by created_at asc limit 1)
  where created_by_admin_id is null;

-- ==========================================
-- Admin Data Files Management Table
-- ==========================================
create table if not exists public.admin_files (
  id uuid primary key default gen_random_uuid(),
  admin_id uuid not null references public.admin(id) on delete cascade,
  file_name text not null,
  file_size bigint not null default 0,
  records_count int not null default 0,
  storage_path text not null,
  file_hash text not null default '',
  version int not null default 1,
  is_active boolean not null default true,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);

create index if not exists admin_files_admin_id_idx
  on public.admin_files (admin_id);

create index if not exists admin_files_is_active_idx
  on public.admin_files (is_active);

alter table public.admin_files enable row level security;

drop policy if exists admin_files_server_access on public.admin_files;
create policy admin_files_server_access
  on public.admin_files
  for all
  to anon, authenticated
  using (true)
  with check (true);

grant select, insert, update, delete on table public.admin_files to anon, authenticated;

