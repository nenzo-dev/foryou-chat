-- "Reply for me" should only speak up when the recipient is actually away -- not fire a reply while
-- they're sitting right there in the app and could answer themselves. presence already tracks this
-- (touch_seen every 30s while the app is open; ONLINE_MS = 90s client-side), so re-use the same window
-- here rather than inventing a second definition of "online".
create or replace function public.maybe_ai_reply(p_conversation text, p_message_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_other uuid; v_sender uuid; v_by_ai boolean; v_secret text; v_last_seen timestamptz;
  v_base text := 'https://mkcyowrofmrlnmlypjou.supabase.co/functions/v1';
begin
  select sender_id, sent_by_ai into v_sender, v_by_ai from public.messages where id = p_message_id;
  if v_by_ai then return; end if;
  select case when user_a_id = v_sender then user_b_id else user_a_id end into v_other
    from public.conversations where id = p_conversation;
  if v_other is null or not exists (select 1 from public.profiles where id = v_other and ai_auto_reply) then return; end if;
  select last_seen into v_last_seen from public.user_presence where id = v_other;
  if v_last_seen is not null and v_last_seen > now() - interval '90 seconds' then return; end if;
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'foryou_trigger_secret';
  if v_secret is null then return; end if;
  perform net.http_post(
    url := v_base || '/ai-reply',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-foryou-secret', v_secret),
    body := jsonb_build_object('conversation_id', p_conversation, 'message_id', p_message_id, 'reply_as', v_other)
  );
end $$;

select 'migration 06 applied' as result;
