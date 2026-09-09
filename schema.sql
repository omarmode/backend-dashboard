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
  last_seen_at timestamp with time zone
);

create index if not exists activation_codes_code_idx
  on public.activation_codes (code);

create index if not exists activation_codes_device_id_idx
  on public.activation_codes (device_id);

create index if not exists activation_codes_expires_at_idx
  on public.activation_codes (expires_at);

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
