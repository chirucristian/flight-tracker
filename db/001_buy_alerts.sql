-- Phase 0: per-user buy-alert email schema
-- Run against the flight-tracker Supabase project (rcwrzmplltjyrzkloiwf).

-- ---------------------------------------------------------------------------
-- notification_preferences: per-user alert settings (frontend-writable via RLS)
-- ---------------------------------------------------------------------------
create table if not exists public.notification_preferences (
  user_id        uuid primary key references auth.users(id) on delete cascade,
  email          text not null,
  alerts_enabled boolean not null default true,
  -- one of: 'GOOD DEAL' | 'BUY NOW'
  min_tier       text not null default 'GOOD DEAL',
  -- optional absolute price ceiling; null = no ceiling
  max_price      numeric,
  updated_at     timestamptz not null default now(),
  constraint notification_preferences_min_tier_chk
    check (min_tier in ('GOOD DEAL', 'BUY NOW'))
);

alter table public.notification_preferences enable row level security;

drop policy if exists "own prefs select" on public.notification_preferences;
create policy "own prefs select" on public.notification_preferences
  for select using (auth.uid() = user_id);

drop policy if exists "own prefs insert" on public.notification_preferences;
create policy "own prefs insert" on public.notification_preferences
  for insert with check (auth.uid() = user_id);

drop policy if exists "own prefs update" on public.notification_preferences;
create policy "own prefs update" on public.notification_preferences
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- user_flight_alert_state: dedup / re-arm ledger (service-role only)
-- RLS enabled with no policies => only the service_role key (which bypasses
-- RLS) can read or write. The anon/authenticated frontend cannot touch it.
-- ---------------------------------------------------------------------------
create table if not exists public.user_flight_alert_state (
  user_id             uuid not null references auth.users(id) on delete cascade,
  flight_key          text not null,
  last_notified_tier  text,
  last_notified_price numeric,
  last_notified_at    timestamptz,
  armed               boolean not null default true,
  primary key (user_id, flight_key)
);

alter table public.user_flight_alert_state enable row level security;
