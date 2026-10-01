-- 08: "Reply for me" actually reaches the AI, and the Android app can check for new messages while
-- it's closed.

-- ---------------------------------------------------------------------
-- 1. AI AUTO-REPLY
--   The ai-reply Edge Function sits behind Supabase's gateway, which refuses any request without a
--   valid JWT in the Authorization header ("Missing authorization header"), so every auto-reply so far
--   was turned away before the function even ran. The project's anon key is such a JWT and is public
--   by design; the shared secret in x-foryou-secret is still what proves a call came from here.
--
--   It also waits 15 seconds between replies in the same chat, so five quick messages in a row get one
--   reply (the function reads the latest messages when it runs) instead of five.
-- ---------------------------------------------------------------------
create table if not exists public.ai_reply_log (
  conversation_id text primary key references public.conversations(id) on delete cascade,
  last_at timestamptz not null default now()
);
alter table public.ai_reply_log enable row level security;
revoke all on public.ai_reply_log from anon, authenticated;

create or replace function public.maybe_ai_reply(p_conversation text, p_message_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_other uuid; v_sender uuid; v_by_ai boolean; v_secret text; v_last_seen timestamptz; v_go text;
  v_base text := 'https://mkcyowrofmrlnmlypjou.supabase.co/functions/v1';
  v_anon text := 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1rY3lvd3JvZm1ybG5tbHlwam91Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA2MjkyNDYsImV4cCI6MjEwNjIwNTI0Nn0.839uFGVmvpE8RpkOSLQgdtAsLrGFmS4yVLKTjbGNguo';
begin
  select sender_id, sent_by_ai into v_sender, v_by_ai from public.messages where id = p_message_id;
  if v_by_ai then return; end if;
  select case when user_a_id = v_sender then user_b_id else user_a_id end into v_other
    from public.conversations where id = p_conversation;
  if v_other is null or not exists (select 1 from public.profiles where id = v_other and ai_auto_reply and not suspended) then return; end if;
  -- Only while they're away: the app checks in every 30 seconds while it's open.
  select last_seen into v_last_seen from public.user_presence where id = v_other;
  if v_last_seen is not null and v_last_seen > now() - interval '90 seconds' then return; end if;
  insert into public.ai_reply_log (conversation_id, last_at) values (p_conversation, now())
    on conflict (conversation_id) do update set last_at = now()
    where public.ai_reply_log.last_at < now() - interval '15 seconds'
    returning conversation_id into v_go;
  if v_go is null then return; end if;
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'foryou_trigger_secret';
  if v_secret is null then return; end if;
  perform net.http_post(
    url := v_base || '/ai-reply',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-foryou-secret', v_secret,
                                  'Authorization', 'Bearer ' || v_anon, 'apikey', v_anon),
    body := jsonb_build_object('conversation_id', p_conversation, 'message_id', p_message_id, 'reply_as', v_other)
  );
end $$;

-- ---------------------------------------------------------------------
-- 2. ANDROID APP: CHECKING FOR MESSAGES WHILE CLOSED
--   When someone signs in on the Android app, the app asks for a device code (register_device). The
--   phone keeps the code; the database keeps only its SHA-256, so a copy of the database can't be used
--   to read anyone's inbox. With the app closed, the phone sends the code to device_inbox() every
--   15 minutes or so and shows a notification for anything new. Signing out deletes the code.
-- ---------------------------------------------------------------------
create table if not exists public.device_tokens (
  token_hash text primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  platform text not null default 'android' check (platform in ('android')),
  created_at timestamptz not null default now(),
  last_used_at timestamptz not null default now()
);
create index if not exists device_tokens_user_idx on public.device_tokens (user_id);
alter table public.device_tokens enable row level security;
revoke all on public.device_tokens from anon, authenticated;

create or replace function public.device_token_hash(p_token text) returns text
language sql immutable as $$ select encode(sha256(convert_to(coalesce(p_token, ''), 'UTF8')), 'hex'); $$;

create or replace function public.register_device(p_platform text default 'android') returns text
language plpgsql security definer set search_path = public as $$
declare v_token text := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  insert into public.device_tokens (token_hash, user_id, platform) values (public.device_token_hash(v_token), auth.uid(), 'android');
  -- A person keeps at most 5 phones signed in; the oldest code stops working.
  delete from public.device_tokens where user_id = auth.uid() and token_hash not in
    (select token_hash from public.device_tokens where user_id = auth.uid() order by created_at desc limit 5);
  return v_token;
end $$;

create or replace function public.unregister_device(p_token text) returns void
language sql security definer set search_path = public as $$
  delete from public.device_tokens where token_hash = public.device_token_hash(p_token);
$$;

-- New messages for the phone holding p_token, since p_since (at most the last 3 days).
create or replace function public.device_inbox(p_token text, p_since timestamptz default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_user uuid; v_since timestamptz;
begin
  update public.device_tokens set last_used_at = now() where token_hash = public.device_token_hash(p_token)
    returning user_id into v_user;
  if v_user is null then return jsonb_build_object('signed_out', true); end if;
  if coalesce((select suspended from public.profiles where id = v_user), false) then
    return jsonb_build_object('now', now(), 'items', '[]'::jsonb, 'ai_replies', 0, 'ai_chats', 0);
  end if;
  v_since := greatest(coalesce(p_since, now() - interval '1 day'), now() - interval '3 days');
  return jsonb_build_object(
    'now', now(),
    'items', coalesce((select jsonb_agg(to_jsonb(x) order by x.at) from (
      select * from (
        select 'dm'::text as kind, m.conversation_id as thread, p.full_name as from_name, null::text as room_name,
               public.message_preview(m.body, m.attachment, m.deleted_at) as text, m.created_at as at, m.sent_by_ai as by_ai
          from public.messages m
          join public.conversations c on c.id = m.conversation_id
          join public.profiles p on p.id = m.sender_id
         where v_user in (c.user_a_id, c.user_b_id) and m.sender_id <> v_user
           and m.read_at is null and m.deleted_at is null and m.created_at > v_since
        union all
        select 'room', m.room_id::text, p.full_name, r.name,
               public.message_preview(m.body, m.attachment, m.deleted_at), m.created_at, false
          from public.room_messages m
          join public.room_members rm on rm.room_id = m.room_id and rm.user_id = v_user
          join public.rooms r on r.id = m.room_id
          join public.profiles p on p.id = m.sender_id
         where m.sender_id <> v_user and m.created_at > rm.last_read_at
           and m.deleted_at is null and m.created_at > v_since
      ) all_new order by at desc limit 30) x), '[]'::jsonb),
    -- Replies the AI sent for this person while they were away: they should follow up.
    'ai_replies', (select count(*) from public.messages where sender_id = v_user and sent_by_ai and created_at > v_since),
    'ai_chats', (select count(distinct conversation_id) from public.messages where sender_id = v_user and sent_by_ai and created_at > v_since)
  );
end $$;

revoke all on function public.device_token_hash(text), public.register_device(text), public.unregister_device(text),
  public.device_inbox(text, timestamptz) from public, anon, authenticated;
grant execute on function public.register_device(text) to authenticated;
grant execute on function public.unregister_device(text), public.device_inbox(text, timestamptz) to anon, authenticated;

select 'migration 08 applied' as result;
