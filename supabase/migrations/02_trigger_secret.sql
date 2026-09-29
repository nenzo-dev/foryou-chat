-- Without this, the ai-reply Edge Function has no way to tell a genuine call from maybe_ai_reply()
-- (the database trigger) apart from anyone on the internet who found its URL -- it has no user to
-- check auth.uid() against, since it runs from a background trigger, not a signed-in request. A shared
-- secret closes that gap: only Postgres (via Vault, below) and the Edge Function (via its own secret,
-- set separately in the Functions > ai-reply > Settings > "Edge Function Secrets" panel) ever see it.
--
-- Run this once per project. Replace the placeholder with a long random string (32+ random characters -
-- e.g. `openssl rand -base64 32`, with the +/= characters stripped), and set the SAME string as the
-- Edge Function secret TRIGGER_SECRET.
select vault.create_secret(
  'REPLACE_WITH_A_LONG_RANDOM_STRING',
  'foryou_trigger_secret',
  'Shared secret so ai-reply (Edge Function) can verify a request really came from maybe_ai_reply().'
) where not exists (select 1 from vault.secrets where name = 'foryou_trigger_secret');

create or replace function public.maybe_ai_reply(p_conversation text, p_message_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_other uuid; v_sender uuid; v_by_ai boolean; v_secret text;
  -- Supabase's managed Postgres refuses "alter database ... set" (needs superuser), so this project's
  -- own Edge Functions base URL is just hardcoded here instead of read from a custom GUC.
  v_base text := 'https://mkcyowrofmrlnmlypjou.supabase.co/functions/v1';
begin
  select sender_id, sent_by_ai into v_sender, v_by_ai from public.messages where id = p_message_id;
  if v_by_ai then return; end if;
  select case when user_a_id = v_sender then user_b_id else user_a_id end into v_other
    from public.conversations where id = p_conversation;
  if v_other is null or not exists (select 1 from public.profiles where id = v_other and ai_auto_reply) then return; end if;
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'foryou_trigger_secret';
  if v_secret is null then return; end if;
  perform net.http_post(
    url := v_base || '/ai-reply',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-foryou-secret', v_secret),
    body := jsonb_build_object('conversation_id', p_conversation, 'message_id', p_message_id, 'reply_as', v_other)
  );
end $$;

select 'migration 02 applied' as result;
