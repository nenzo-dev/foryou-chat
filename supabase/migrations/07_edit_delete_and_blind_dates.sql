-- 07: edit and delete messages (DMs and groups), "delete for me", and UNILUS blind dates.
--
-- Edits and deletes go through SECURITY DEFINER functions only -- the client update grant on messages
-- stays limited to read_at, so nobody can rewrite someone else's words or backdate their own. A deleted
-- message is kept as an empty "tombstone" row (deleted_at set, body and attachment cleared) so replies
-- that quoted it and the order of the thread still make sense afterwards.
--
-- Errors raised with hint 'fy:show' are written for people to read and the app shows them as they are;
-- every other error is replaced in the app by one generic "something went wrong" line.

-- ---------------------------------------------------------------------
-- EDIT / DELETE
-- ---------------------------------------------------------------------
alter table public.messages add column if not exists edited_at timestamptz;
alter table public.messages add column if not exists deleted_at timestamptz;
alter table public.room_messages add column if not exists edited_at timestamptz;
alter table public.room_messages add column if not exists deleted_at timestamptz;

create or replace function public.message_preview(p_body text, p_attachment jsonb, p_deleted timestamptz) returns text
language sql immutable as $$
  select left(case
    when p_deleted is not null then 'Message deleted'
    else coalesce(nullif(btrim(p_body), ''),
      case when p_attachment ->> 'type' like 'audio/%' then 'Voice message'
           when p_attachment ->> 'type' like 'image/%' then 'Photo'
           when p_attachment is not null then 'Attachment' else '' end)
  end, 90);
$$;

-- The chat list shows the newest message's text, so editing or deleting that message has to update it.
create or replace function public.refresh_conversation_preview(p_conversation text) returns void
language sql security definer set search_path = public as $$
  update public.conversations set last_message_preview = coalesce((
    select public.message_preview(m.body, m.attachment, m.deleted_at) from public.messages m
    where m.conversation_id = p_conversation order by m.created_at desc limit 1), '')
  where id = p_conversation;
$$;
create or replace function public.refresh_room_preview(p_room uuid) returns void
language sql security definer set search_path = public as $$
  update public.rooms set last_message_preview = coalesce((
    select public.message_preview(m.body, m.attachment, m.deleted_at) from public.room_messages m
    where m.room_id = p_room order by m.created_at desc limit 1), '')
  where id = p_room;
$$;
revoke all on function public.refresh_conversation_preview(text), public.refresh_room_preview(uuid) from public, anon, authenticated;

create or replace function public.edit_message(p_message uuid, p_body text) returns public.messages
language plpgsql security definer set search_path = public as $$
declare v_msg public.messages%rowtype; v_text text := btrim(coalesce(p_body, ''));
begin
  if public.i_am_suspended() then raise exception 'Your account is suspended'; end if;
  select * into v_msg from public.messages where id = p_message for update;
  if not found or v_msg.sender_id <> auth.uid() or not public.i_am_participant(v_msg.conversation_id) then
    raise exception 'You can only edit your own messages.' using hint = 'fy:show';
  end if;
  if v_msg.deleted_at is not null then raise exception 'That message was deleted.' using hint = 'fy:show'; end if;
  if v_msg.attachment ->> 'type' like 'audio/%' then raise exception 'Voice messages can''t be edited.' using hint = 'fy:show'; end if;
  if v_text = '' and v_msg.attachment is null then raise exception 'Type something, or delete the message instead.' using hint = 'fy:show'; end if;
  if char_length(v_text) > 4000 then raise exception 'That message is too long.' using hint = 'fy:show'; end if;
  if v_text = v_msg.body then return v_msg; end if;
  update public.messages set body = v_text, edited_at = now() where id = p_message returning * into v_msg;
  perform public.refresh_conversation_preview(v_msg.conversation_id);
  return v_msg;
end $$;

-- Returns the storage path of the attachment the message had (if any), so the app can remove the file.
create or replace function public.delete_message(p_message uuid) returns text
language plpgsql security definer set search_path = public as $$
declare v_msg public.messages%rowtype;
begin
  select * into v_msg from public.messages where id = p_message for update;
  if not found or v_msg.sender_id <> auth.uid() or not public.i_am_participant(v_msg.conversation_id) then
    raise exception 'You can only delete your own messages.' using hint = 'fy:show';
  end if;
  if v_msg.deleted_at is not null then return null; end if;
  update public.messages set body = '', attachment = null, edited_at = null, deleted_at = now() where id = p_message;
  delete from public.message_reactions where message_id = p_message;
  perform public.refresh_conversation_preview(v_msg.conversation_id);
  return v_msg.attachment ->> 'path';
end $$;

create or replace function public.edit_room_message(p_message uuid, p_body text) returns public.room_messages
language plpgsql security definer set search_path = public as $$
declare v_msg public.room_messages%rowtype; v_text text := btrim(coalesce(p_body, ''));
begin
  if public.i_am_suspended() then raise exception 'Your account is suspended'; end if;
  select * into v_msg from public.room_messages where id = p_message for update;
  if not found or v_msg.sender_id <> auth.uid() or not public.i_am_room_member(v_msg.room_id) then
    raise exception 'You can only edit your own messages.' using hint = 'fy:show';
  end if;
  if v_msg.deleted_at is not null then raise exception 'That message was deleted.' using hint = 'fy:show'; end if;
  if v_msg.attachment ->> 'type' like 'audio/%' then raise exception 'Voice messages can''t be edited.' using hint = 'fy:show'; end if;
  if v_text = '' and v_msg.attachment is null then raise exception 'Type something, or delete the message instead.' using hint = 'fy:show'; end if;
  if char_length(v_text) > 4000 then raise exception 'That message is too long.' using hint = 'fy:show'; end if;
  if v_text = v_msg.body then return v_msg; end if;
  update public.room_messages set body = v_text, edited_at = now() where id = p_message returning * into v_msg;
  perform public.refresh_room_preview(v_msg.room_id);
  return v_msg;
end $$;

-- In a group the sender can delete their own message, and the group owner can remove anyone's.
create or replace function public.delete_room_message(p_message uuid) returns text
language plpgsql security definer set search_path = public as $$
declare v_msg public.room_messages%rowtype;
begin
  select * into v_msg from public.room_messages where id = p_message for update;
  if not found or not public.i_am_room_member(v_msg.room_id)
     or (v_msg.sender_id <> auth.uid() and not public.i_own_room(v_msg.room_id)) then
    raise exception 'You can only delete your own messages.' using hint = 'fy:show';
  end if;
  if v_msg.deleted_at is not null then return null; end if;
  update public.room_messages set body = '', attachment = null, edited_at = null, deleted_at = now() where id = p_message;
  delete from public.room_message_reactions where message_id = p_message;
  perform public.refresh_room_preview(v_msg.room_id);
  return v_msg.attachment ->> 'path';
end $$;

revoke all on function public.edit_message(uuid, text), public.delete_message(uuid),
  public.edit_room_message(uuid, text), public.delete_room_message(uuid) from public, anon;
grant execute on function public.edit_message(uuid, text), public.delete_message(uuid),
  public.edit_room_message(uuid, text), public.delete_room_message(uuid) to authenticated;

-- "Delete for me": hides any message you can see from your own view only. One table for DMs and groups
-- alike (message ids are UUIDs, so they never collide between the two).
create table if not exists public.hidden_messages (
  user_id uuid not null references public.profiles(id) on delete cascade,
  message_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (user_id, message_id)
);
alter table public.hidden_messages enable row level security;
revoke all on public.hidden_messages from anon, authenticated;
grant select on public.hidden_messages to authenticated;
drop policy if exists hidden_messages_select on public.hidden_messages;
create policy hidden_messages_select on public.hidden_messages for select to authenticated using (user_id = auth.uid());

create or replace function public.hide_message(p_message uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  if not exists (select 1 from public.messages m where m.id = p_message and public.i_am_participant(m.conversation_id))
     and not exists (select 1 from public.room_messages m where m.id = p_message and public.i_am_room_member(m.room_id)) then
    raise exception 'That message could not be found.' using hint = 'fy:show';
  end if;
  insert into public.hidden_messages (user_id, message_id) values (auth.uid(), p_message) on conflict do nothing;
end $$;
revoke all on function public.hide_message(uuid) from public, anon;
grant execute on function public.hide_message(uuid) to authenticated;

-- Let people remove the files they uploaded themselves (a deleted photo or voice note shouldn't linger in
-- storage). Newer Supabase projects record the uploader in owner_id (text), older ones in owner (uuid).
drop policy if exists attachments_delete_own on storage.objects;
do $$
begin
  if exists (select 1 from information_schema.columns where table_schema = 'storage' and table_name = 'objects' and column_name = 'owner_id') then
    execute $p$create policy attachments_delete_own on storage.objects for delete to authenticated
      using (bucket_id = 'attachments' and owner_id = auth.uid()::text)$p$;
  else
    execute $p$create policy attachments_delete_own on storage.objects for delete to authenticated
      using (bucket_id = 'attachments' and owner = auth.uid())$p$;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- UNILUS BLIND DATES
--   Up to three seats: one host (the matchmaker, who can see everyone) and two daters, who can hear
--   each other but not see each other until the host opens the blindfold. With no host in the room, the
--   daters open it together once both have said they're ready.
--
--   Nothing here is readable directly by the app: every read goes through the functions below, which
--   hide one dater's name and photo from the other until the reveal. People are addressed in the video
--   call by their seat id (blind_date_members.id), never their account id, for the same reason.
-- ---------------------------------------------------------------------
create table if not exists public.blind_dates (
  id uuid primary key default gen_random_uuid(),
  title text not null default '' check (char_length(title) <= 60),
  created_by uuid not null references public.profiles(id) on delete cascade,
  is_public boolean not null default true,
  call_secret text not null default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
  created_at timestamptz not null default now(),
  revealed_at timestamptz,
  ended_at timestamptz
);
create table if not exists public.blind_date_members (
  id uuid primary key default gen_random_uuid(),
  date_id uuid not null references public.blind_dates(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role text not null check (role in ('host', 'dater')),
  joined_at timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  ready_at timestamptz,
  unique (date_id, user_id)
);
create index if not exists blind_date_members_date_idx on public.blind_date_members (date_id);
create index if not exists blind_dates_open_idx on public.blind_dates (created_at desc) where ended_at is null;
alter table public.blind_dates enable row level security;
alter table public.blind_date_members enable row level security;
revoke all on public.blind_dates, public.blind_date_members from anon, authenticated;

-- A seat counts as taken while its person has checked in within the last 40 seconds (the app checks in
-- every 12 seconds while the date is open).
create or replace function public.bd_active(p_seen timestamptz) returns boolean
language sql stable as $$ select p_seen > now() - interval '40 seconds'; $$;

-- Everything the date screen needs, from the point of view of the person asking.
create or replace function public.bd_state(p_date uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare d public.blind_dates%rowtype; me public.blind_date_members%rowtype; v_people jsonb;
begin
  select * into d from public.blind_dates where id = p_date;
  if not found then return null; end if;
  select * into me from public.blind_date_members where date_id = p_date and user_id = auth.uid();
  if not found then return null; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
      'seat', m.id,
      'role', m.role,
      'is_me', m.user_id = auth.uid(),
      'active', public.bd_active(m.last_seen),
      'ready', m.ready_at is not null,
      'masked', masked,
      'name', case when masked then null else p.full_name end,
      'avatar_path', case when masked then null else p.avatar_path end,
      'avatar_color', case when masked then null else p.avatar_color end
    ) order by (m.role = 'host') desc, m.joined_at), '[]'::jsonb)
    into v_people
    from public.blind_date_members m
    join public.profiles p on p.id = m.user_id
    cross join lateral (select (me.role = 'dater' and m.role = 'dater' and m.user_id <> auth.uid() and d.revealed_at is null) as masked) x
    where m.date_id = p_date;
  return jsonb_build_object(
    'id', d.id, 'title', d.title, 'is_public', d.is_public,
    'revealed', d.revealed_at is not null, 'revealed_at', d.revealed_at,
    'ended', d.ended_at is not null,
    'my_seat', me.id, 'my_role', me.role,
    'people', v_people);
end $$;
revoke all on function public.bd_state(uuid) from public, anon, authenticated;

-- What anyone signed in may see before taking a seat (the link is the invitation).
create or replace function public.blind_date_info(p_date uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', d.id, 'title', d.title,
    'revealed', d.revealed_at is not null, 'ended', d.ended_at is not null,
    'host_name', (select p.full_name from public.blind_date_members m join public.profiles p on p.id = m.user_id
                  where m.date_id = d.id and m.role = 'host' and public.bd_active(m.last_seen) limit 1),
    'host_open', not exists (select 1 from public.blind_date_members m where m.date_id = d.id and m.role = 'host' and public.bd_active(m.last_seen)),
    'daters', (select count(*) from public.blind_date_members m where m.date_id = d.id and m.role = 'dater' and public.bd_active(m.last_seen)),
    'my_role', (select m.role from public.blind_date_members m where m.date_id = d.id and m.user_id = auth.uid()))
  from public.blind_dates d where d.id = p_date and auth.uid() is not null;
$$;

create or replace function public.blind_date_lobby()
returns table (id uuid, title text, host_name text, host_avatar_path text, host_avatar_color text, host_open boolean,
               daters int, created_at timestamptz, mine boolean, revealed boolean)
language sql stable security definer set search_path = public as $$
  select d.id, d.title, hp.full_name, hp.avatar_path, hp.avatar_color, h.user_id is null,
    (select count(*)::int from public.blind_date_members m where m.date_id = d.id and m.role = 'dater' and public.bd_active(m.last_seen)),
    d.created_at,
    exists (select 1 from public.blind_date_members m where m.date_id = d.id and m.user_id = auth.uid()),
    d.revealed_at is not null
  from public.blind_dates d
  left join lateral (select m.user_id from public.blind_date_members m
                     where m.date_id = d.id and m.role = 'host' and public.bd_active(m.last_seen) limit 1) h on true
  left join public.profiles hp on hp.id = h.user_id
  where auth.uid() is not null and d.ended_at is null
    and exists (select 1 from public.blind_date_members m where m.date_id = d.id and public.bd_active(m.last_seen))
    and ((d.is_public and d.revealed_at is null)
         or exists (select 1 from public.blind_date_members m where m.date_id = d.id and m.user_id = auth.uid()))
  order by d.created_at desc
  limit 60;
$$;

create or replace function public.create_blind_date(p_title text, p_role text, p_public boolean default true) returns jsonb
language plpgsql security definer set search_path = public as $$
declare d public.blind_dates%rowtype; me public.blind_date_members%rowtype;
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  if public.i_am_suspended() then raise exception 'Your account is suspended'; end if;
  if p_role not in ('host', 'dater') then raise exception 'Pick a seat first.' using hint = 'fy:show'; end if;
  -- Tidy up dates nobody has been in for a while, then keep one person from opening dozens.
  delete from public.blind_dates x where x.created_at < now() - interval '15 minutes'
    and not exists (select 1 from public.blind_date_members m where m.date_id = x.id and m.last_seen > now() - interval '15 minutes');
  if (select count(*) from public.blind_dates x where x.created_by = auth.uid() and x.ended_at is null) >= 3 then
    raise exception 'You already have 3 blind dates open. Close one before starting another.' using hint = 'fy:show';
  end if;
  insert into public.blind_dates (title, created_by, is_public)
    values (left(btrim(coalesce(p_title, '')), 60), auth.uid(), coalesce(p_public, true)) returning * into d;
  insert into public.blind_date_members (date_id, user_id, role) values (d.id, auth.uid(), p_role) returning * into me;
  return jsonb_build_object('id', d.id, 'seat', me.id, 'role', me.role, 'secret', d.call_secret);
end $$;

-- Takes a seat, or re-enters the seat you already have (after a reload, say).
create or replace function public.join_blind_date(p_date uuid, p_role text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare d public.blind_dates%rowtype; me public.blind_date_members%rowtype; n int;
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  if public.i_am_suspended() then raise exception 'Your account is suspended'; end if;
  select * into d from public.blind_dates where id = p_date for update;
  if not found then raise exception 'This blind date doesn''t exist any more.' using hint = 'fy:show'; end if;
  if d.ended_at is not null then raise exception 'This blind date has ended.' using hint = 'fy:show'; end if;
  select * into me from public.blind_date_members where date_id = p_date and user_id = auth.uid();
  if found then
    update public.blind_date_members set last_seen = now() where id = me.id;
  else
    if p_role is null or p_role not in ('host', 'dater') then raise exception 'Pick a seat first.' using hint = 'fy:show'; end if;
    if d.revealed_at is not null then raise exception 'This date has already been revealed.' using hint = 'fy:show'; end if;
    delete from public.blind_date_members where date_id = p_date and role = p_role and not public.bd_active(last_seen);
    select count(*) into n from public.blind_date_members where date_id = p_date and role = p_role;
    if p_role = 'host' and n >= 1 then raise exception 'This date already has a host.' using hint = 'fy:show'; end if;
    if p_role = 'dater' and n >= 2 then raise exception 'Both dater seats are taken.' using hint = 'fy:show'; end if;
    insert into public.blind_date_members (date_id, user_id, role) values (p_date, auth.uid(), p_role) returning * into me;
  end if;
  return jsonb_build_object('id', d.id, 'seat', me.id, 'role', me.role, 'secret', d.call_secret);
end $$;

-- The date screen checks in with this every few seconds: keeps the seat, and returns the current state.
create or replace function public.blind_date_beat(p_date uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  update public.blind_date_members set last_seen = now() where date_id = p_date and user_id = auth.uid();
  if not found then raise exception 'You''re not in this blind date.' using hint = 'fy:show'; end if;
  return public.bd_state(p_date);
end $$;

create or replace function public.reveal_blind_date(p_date uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare d public.blind_dates%rowtype; me public.blind_date_members%rowtype; v_daters int; v_host boolean;
begin
  select * into d from public.blind_dates where id = p_date for update;
  if not found or d.ended_at is not null then raise exception 'This blind date has ended.' using hint = 'fy:show'; end if;
  select * into me from public.blind_date_members where date_id = p_date and user_id = auth.uid();
  if not found then raise exception 'You''re not in this blind date.' using hint = 'fy:show'; end if;
  update public.blind_date_members set last_seen = now() where id = me.id;
  if d.revealed_at is not null then return public.bd_state(p_date); end if;
  select count(*) into v_daters from public.blind_date_members where date_id = p_date and role = 'dater' and public.bd_active(last_seen);
  if v_daters < 2 then raise exception 'Wait until both daters are here.' using hint = 'fy:show'; end if;
  v_host := exists (select 1 from public.blind_date_members where date_id = p_date and role = 'host' and public.bd_active(last_seen));
  if me.role = 'host' then
    update public.blind_dates set revealed_at = now() where id = p_date;
  elsif v_host then
    raise exception 'Only the host can open the blindfold.' using hint = 'fy:show';
  else
    update public.blind_date_members set ready_at = coalesce(ready_at, now()) where id = me.id;
    if (select count(*) from public.blind_date_members where date_id = p_date and role = 'dater'
        and ready_at is not null and public.bd_active(last_seen)) >= 2 then
      update public.blind_dates set revealed_at = now() where id = p_date;
    end if;
  end if;
  return public.bd_state(p_date);
end $$;

create or replace function public.end_blind_date(p_date uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.blind_date_members where date_id = p_date and user_id = auth.uid() and role = 'host') then
    raise exception 'Only the host can end the date for everyone.' using hint = 'fy:show';
  end if;
  update public.blind_dates set ended_at = coalesce(ended_at, now()) where id = p_date;
end $$;

create or replace function public.leave_blind_date(p_date uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  delete from public.blind_date_members where date_id = p_date and user_id = auth.uid();
  if not exists (select 1 from public.blind_date_members where date_id = p_date) then
    delete from public.blind_dates where id = p_date;
  end if;
end $$;

revoke all on function public.bd_active(timestamptz), public.blind_date_info(uuid), public.blind_date_lobby(),
  public.create_blind_date(text, text, boolean), public.join_blind_date(uuid, text), public.blind_date_beat(uuid),
  public.reveal_blind_date(uuid), public.end_blind_date(uuid), public.leave_blind_date(uuid) from public, anon;
grant execute on function public.bd_active(timestamptz), public.blind_date_info(uuid), public.blind_date_lobby(),
  public.create_blind_date(text, text, boolean), public.join_blind_date(uuid, text), public.blind_date_beat(uuid),
  public.reveal_blind_date(uuid), public.end_blind_date(uuid), public.leave_blind_date(uuid) to authenticated;

select 'migration 07 applied' as result;
