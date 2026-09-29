-- Two WhatsApp/Telegram-style features on top of messaging: swipe-to-reply (a message can quote an
-- earlier one) and tap-to-react (one emoji per person per message, tapping the same one again removes
-- it). Separate reaction tables for DMs and rooms, mirroring messages/room_messages, so each can reuse
-- a straightforward foreign key instead of a polymorphic one.

alter table public.messages add column if not exists reply_to_id uuid references public.messages(id) on delete set null;
alter table public.room_messages add column if not exists reply_to_id uuid references public.room_messages(id) on delete set null;

create table if not exists public.message_reactions (
  message_id uuid not null references public.messages(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  emoji text not null check (char_length(emoji) <= 8),
  created_at timestamptz not null default now(),
  primary key (message_id, user_id)
);
create table if not exists public.room_message_reactions (
  message_id uuid not null references public.room_messages(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  emoji text not null check (char_length(emoji) <= 8),
  created_at timestamptz not null default now(),
  primary key (message_id, user_id)
);
alter table public.message_reactions enable row level security;
alter table public.room_message_reactions enable row level security;
revoke all on public.message_reactions, public.room_message_reactions from anon, authenticated;
grant select on public.message_reactions, public.room_message_reactions to authenticated;

create policy reactions_select on public.message_reactions for select to authenticated
  using (exists (select 1 from public.messages m where m.id = message_id and public.i_am_participant(m.conversation_id)));
create policy room_reactions_select on public.room_message_reactions for select to authenticated
  using (exists (select 1 from public.room_messages m where m.id = message_id and public.i_am_room_member(m.room_id)));

create or replace function public.toggle_message_reaction(p_message uuid, p_emoji text) returns void
language plpgsql security definer set search_path = public as $$
declare v_conv text; v_emoji text := left(btrim(p_emoji), 8);
begin
  select conversation_id into v_conv from public.messages where id = p_message;
  if v_conv is null or not public.i_am_participant(v_conv) then raise exception 'Not your conversation'; end if;
  if v_emoji = '' then raise exception 'No emoji given'; end if;
  if exists (select 1 from public.message_reactions where message_id = p_message and user_id = auth.uid() and emoji = v_emoji) then
    delete from public.message_reactions where message_id = p_message and user_id = auth.uid() and emoji = v_emoji;
  else
    insert into public.message_reactions (message_id, user_id, emoji) values (p_message, auth.uid(), v_emoji)
    on conflict (message_id, user_id) do update set emoji = excluded.emoji, created_at = now();
  end if;
end $$;
revoke all on function public.toggle_message_reaction(uuid, text) from public, anon;
grant execute on function public.toggle_message_reaction(uuid, text) to authenticated;

create or replace function public.toggle_room_message_reaction(p_message uuid, p_emoji text) returns void
language plpgsql security definer set search_path = public as $$
declare v_room uuid; v_emoji text := left(btrim(p_emoji), 8);
begin
  select room_id into v_room from public.room_messages where id = p_message;
  if v_room is null or not public.i_am_room_member(v_room) then raise exception 'Not a member of this room'; end if;
  if v_emoji = '' then raise exception 'No emoji given'; end if;
  if exists (select 1 from public.room_message_reactions where message_id = p_message and user_id = auth.uid() and emoji = v_emoji) then
    delete from public.room_message_reactions where message_id = p_message and user_id = auth.uid() and emoji = v_emoji;
  else
    insert into public.room_message_reactions (message_id, user_id, emoji) values (p_message, auth.uid(), v_emoji)
    on conflict (message_id, user_id) do update set emoji = excluded.emoji, created_at = now();
  end if;
end $$;
revoke all on function public.toggle_room_message_reaction(uuid, text) from public, anon;
grant execute on function public.toggle_room_message_reaction(uuid, text) to authenticated;

-- create or replace can't change a function's parameter list in place -- it would add a second,
-- ambiguous overload instead of replacing the original, so the old signatures are dropped first.
drop function if exists public.send_message(text, text, jsonb, boolean);
drop function if exists public.send_room_message(uuid, text, jsonb);

create or replace function public.send_message(p_conversation text, p_body text, p_attachment jsonb default null, p_by_ai boolean default false, p_reply_to uuid default null)
returns public.messages
language plpgsql security definer set search_path = public as $$
declare v_msg public.messages%rowtype; v_text text := btrim(coalesce(p_body, ''));
begin
  if not public.i_am_participant(p_conversation) then raise exception 'Not your conversation'; end if;
  if v_text = '' and p_attachment is null then raise exception 'Empty message'; end if;
  if p_reply_to is not null and not exists (select 1 from public.messages where id = p_reply_to and conversation_id = p_conversation) then
    p_reply_to := null;
  end if;
  insert into public.messages (conversation_id, sender_id, body, attachment, sent_by_ai, reply_to_id)
    values (p_conversation, auth.uid(), v_text, p_attachment, coalesce(p_by_ai, false), p_reply_to)
    returning * into v_msg;
  update public.conversations set last_message_at = v_msg.created_at,
    last_message_preview = left(coalesce(nullif(v_text, ''), case when p_attachment ->> 'type' like 'audio/%' then 'Voice message' else 'Attachment' end), 90)
    where id = p_conversation;
  perform public.maybe_ai_reply(p_conversation, v_msg.id);
  return v_msg;
end $$;
grant execute on function public.send_message(text, text, jsonb, boolean, uuid) to authenticated;

create or replace function public.send_room_message(p_room uuid, p_body text, p_attachment jsonb default null, p_reply_to uuid default null)
returns public.room_messages
language plpgsql security definer set search_path = public as $$
declare v_msg public.room_messages%rowtype; v_text text := btrim(coalesce(p_body, ''));
begin
  if not public.i_am_room_member(p_room) then raise exception 'Not a member of this room'; end if;
  if v_text = '' and p_attachment is null then raise exception 'Empty message'; end if;
  if p_reply_to is not null and not exists (select 1 from public.room_messages where id = p_reply_to and room_id = p_room) then
    p_reply_to := null;
  end if;
  insert into public.room_messages (room_id, sender_id, body, attachment, reply_to_id) values (p_room, auth.uid(), v_text, p_attachment, p_reply_to) returning * into v_msg;
  return v_msg;
end $$;
grant execute on function public.send_room_message(uuid, text, jsonb, uuid) to authenticated;

do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'message_reactions') then
    alter publication supabase_realtime add table public.message_reactions;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'room_message_reactions') then
    alter publication supabase_realtime add table public.room_message_reactions;
  end if;
end $$;

select 'migration 03 applied' as result;
