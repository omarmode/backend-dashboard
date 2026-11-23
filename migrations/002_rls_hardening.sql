-- ============================================================================
-- Migration 002: Production RLS Hardening (Apply AFTER Setting
-- SUPABASE_SERVICE_ROLE_KEY on Render Environment Variables!)
-- ============================================================================
-- IMPORTANT:
-- Do NOT run this file while the backend server is still using SUPABASE_ANON_KEY.
-- First set SUPABASE_SERVICE_ROLE_KEY in Render, verify server startup, then run
-- this script in Supabase SQL Editor to lock down direct anon/authenticated access.
-- ============================================================================

-- 1. Revoke direct table permissions from anon and authenticated roles
revoke all on table public.admin from anon, authenticated;
revoke all on table public.activation_codes from anon, authenticated;
revoke all on table public.managers from anon, authenticated;
revoke all on table public.manager_files from anon, authenticated;
revoke execute on function public.issue_manager_user_codes(uuid, jsonb, uuid) from anon, authenticated;
revoke execute on function public.update_manager_quota(uuid, integer) from anon, authenticated;

-- 2. Drop permissive policies (service_role bypasses RLS automatically)
drop policy if exists admin_server_access on public.admin;
drop policy if exists activation_codes_server_access on public.activation_codes;
drop policy if exists managers_server_access on public.managers;
drop policy if exists manager_files_server_access on public.manager_files;
drop policy if exists admin_files_server_access on public.admin_files;

-- 3. Ensure RLS stays enabled on all tables (deny-by-default for non-service roles)
alter table public.admin enable row level security;
alter table public.activation_codes enable row level security;
alter table public.managers enable row level security;
alter table public.manager_files enable row level security;

-- 4. Ensure storage bucket remains strictly private (accessible only via service_role)
update storage.buckets
set public = false
where id = 'manager-files';

drop policy if exists "Public Access manager-files" on storage.objects;
