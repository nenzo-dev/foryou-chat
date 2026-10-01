-- 09: push notifications for the Android app (Firebase Cloud Messaging), so an incoming call rings and
-- a new message arrives even while the app is closed.
--
--   - The app registers its Firebase push token against its device code (set_push_token).
--   - A new message calls the "push" Edge Function (supabase/functions/push), but only when someone who
--     should hear about it has a phone with a push token.
--   - Calls are pushed by the caller's app through the same function, with the caller's own sign-in.
-- The background check from migration 08 stays as a fallback.

alter table public.device_tokens add column if not exists fcm_token text check (fcm_token is null or char_length(fcm_token) <= 4096);
create index if not exists device_tokens_fcm_idx on public.device_tokens (user_id) where fcm_token is not null;

-- The phone holding p_token (its device code) tells us where to send pushes. Returns false if the code
-- isn't known any more (signed out), so the app can stop trying.
create or replace function public.set_push_token(p_token text, p_fcm text) returns boolean
language plpgsql security definer set search_path = public as $$
declare v_fcm text := nullif(btrim(coalesce(p_fcm, '')), '');
begin
  if v_fcm is not null and char_length(v_fcm) > 4096 then return false; end if;
  -- One device code per push token: a phone that signed in again replaces its old registration.
  if v_fcm is not null then
    update public.device_tokens set fcm_token = null
      where fcm_token = v_fcm and token_hash <> public.device_token_hash(p_token);
  end if;
  update public.device_tokens set fcm_token = v_fcm, last_used_at = now()
    where token_hash = public.device_token_hash(p_token);
  return found;
end $$;
revoke all on function public.set_push_token(text, text) from public;
grant execute on function public.set_push_token(text, text) to anon, authenticated;

-- After a message is sent: hand it to the push function if anyone who should hear about it has a phone
-- that can receive pushes. Never blocks or fails the message itself.
create or replace function public.push_new_message() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_kind text := case when tg_table_name = 'messages' then 'dm' else 'room' end; v_wanted boolean;
  v_base text := 'https://mkcyowrofmrlnmlypjou.supabase.co/functions/v1';
  v_anon text := 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1rY3lvd3JvZm1ybG5tbHlwam91Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA2MjkyNDYsImV4cCI6MjEwNjIwNTI0Nn0.839uFGVmvpE8RpkOSLQgdtAsLrGFmS4yVLKTjbGNguo';
begin
  if v_kind = 'dm' then
    select exists (
      select 1 from public.conversations c
      join public.device_tokens d on d.user_id = case when c.user_a_id = new.sender_id then c.user_b_id else c.user_a_id end
      where c.id = new.conversation_id and d.fcm_token is not null) into v_wanted;
  else
    select exists (
      select 1 from public.room_members m
      join public.device_tokens d on d.user_id = m.user_id
      where m.room_id = new.room_id and m.user_id <> new.sender_id and d.fcm_token is not null) into v_wanted;
  end if;
  if v_wanted then
    perform net.http_post(
      url := v_base || '/push',
      headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_anon, 'apikey', v_anon),
      body := jsonb_build_object('type', 'message', 'kind', v_kind, 'id', new.id)
    );
  end if;
  return new;
exception when others then
  return new;
end $$;
revoke all on function public.push_new_message() from public, anon, authenticated;

drop trigger if exists messages_push on public.messages;
create trigger messages_push after insert on public.messages for each row execute function public.push_new_message();
drop trigger if exists room_messages_push on public.room_messages;
create trigger room_messages_push after insert on public.room_messages for each row execute function public.push_new_message();

select 'migration 09 applied' as result;
