-- Two follow-ups on top of schema.sql:
--   1. Put the live-updating tables on the realtime publication, so the app finds out about a new
--      message / room / room member the instant it happens, instead of polling.
--   2. A service-role-only insert path for the AI auto-reply Edge Function: it runs with no signed-in
--      user (it is called from a database trigger via pg_net, not from a browser), so it cannot pass
--      send_message()'s "sender_id = auth.uid()" check. ai_send_message() does the same insert and the
--      same conversation preview update, trusted because only the service role key can call it.
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'messages') then
    alter publication supabase_realtime add table public.messages;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'conversations') then
    alter publication supabase_realtime add table public.conversations;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'room_messages') then
    alter publication supabase_realtime add table public.room_messages;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'rooms') then
    alter publication supabase_realtime add table public.rooms;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'room_members') then
    alter publication supabase_realtime add table public.room_members;
  end if;
end $$;

create or replace function public.ai_send_message(p_conversation text, p_sender uuid, p_body text)
returns public.messages
language plpgsql security definer set search_path = public as $$
declare v_msg public.messages%rowtype; v_text text := left(btrim(coalesce(p_body, '')), 4000);
begin
  if v_text = '' then raise exception 'Empty message'; end if;
  if not exists (select 1 from public.conversations where id = p_conversation and p_sender in (user_a_id, user_b_id)) then
    raise exception 'Not a participant';
  end if;
  insert into public.messages (conversation_id, sender_id, body, sent_by_ai)
    values (p_conversation, p_sender, v_text, true)
    returning * into v_msg;
  update public.conversations set last_message_at = v_msg.created_at, last_message_preview = left(v_text, 90)
    where id = p_conversation;
  return v_msg;
end $$;
revoke all on function public.ai_send_message(text, uuid, text) from public, anon, authenticated;
grant execute on function public.ai_send_message(text, uuid, text) to service_role;

select 'migration 01 applied' as result;
