-- Account suspension, gated to the configurer only, with an appeal a suspended person can submit and
-- the configurer can approve (lifts the suspension) or deny (leaves it in place).

alter table public.profiles add column if not exists suspended boolean not null default false;
alter table public.profiles add column if not exists suspended_reason text;
alter table public.profiles add column if not exists suspended_at timestamptz;
-- suspended/suspended_reason/suspended_at are deliberately left out of the client update-column grant
-- (see profiles' "grant update (...)" in schema.sql) -- only the SECURITY DEFINER functions below, which
-- run as the table owner regardless of the caller's own grants, are ever allowed to change them.

create table if not exists public.account_appeals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  message text not null check (char_length(message) <= 2000),
  status text not null default 'pending' check (status in ('pending', 'approved', 'denied')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references public.profiles(id)
);
alter table public.account_appeals enable row level security;
revoke all on public.account_appeals from anon, authenticated;
grant select on public.account_appeals to authenticated;
create policy own_appeals_select on public.account_appeals for select to authenticated using (user_id = auth.uid());

create or replace function public.i_am_suspended() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select suspended from public.profiles where id = auth.uid()), false);
$$;

-- ---------------------------------------------------------------------
-- The suspended person's own side: submit one appeal while they wait.
-- ---------------------------------------------------------------------
create or replace function public.submit_appeal(p_message text) returns void
language plpgsql security definer set search_path = public as $$
declare v_text text := btrim(coalesce(p_message, ''));
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  if not public.i_am_suspended() then raise exception 'Your account is not suspended'; end if;
  if v_text = '' then raise exception 'Write a short message first'; end if;
  if exists (select 1 from public.account_appeals where user_id = auth.uid() and status = 'pending') then
    raise exception 'You already have an appeal pending review';
  end if;
  insert into public.account_appeals (user_id, message) values (auth.uid(), left(v_text, 2000));
end $$;
revoke all on function public.submit_appeal(text) from public, anon;
grant execute on function public.submit_appeal(text) to authenticated;

-- ---------------------------------------------------------------------
-- Configurer-only admin actions.
-- ---------------------------------------------------------------------
create or replace function public.admin_list_users() returns table (
  id uuid, email text, full_name text, username text, suspended boolean, suspended_reason text,
  created_at timestamptz, is_configurer boolean
)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.am_i_configurer() then raise exception 'Configurer only'; end if;
  return query select p.id, p.email, p.full_name, p.username, p.suspended, p.suspended_reason, p.created_at, p.is_configurer
    from public.profiles p order by p.created_at desc;
end $$;
revoke all on function public.admin_list_users() from public, anon;
grant execute on function public.admin_list_users() to authenticated;

create or replace function public.admin_suspend_user(p_user uuid, p_reason text default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.am_i_configurer() then raise exception 'Configurer only'; end if;
  if p_user = auth.uid() then raise exception 'You cannot suspend yourself'; end if;
  update public.profiles set suspended = true, suspended_reason = nullif(btrim(coalesce(p_reason, '')), ''), suspended_at = now()
    where id = p_user;
end $$;
revoke all on function public.admin_suspend_user(uuid, text) from public, anon;
grant execute on function public.admin_suspend_user(uuid, text) to authenticated;

create or replace function public.admin_unsuspend_user(p_user uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.am_i_configurer() then raise exception 'Configurer only'; end if;
  update public.profiles set suspended = false, suspended_reason = null where id = p_user;
end $$;
revoke all on function public.admin_unsuspend_user(uuid) from public, anon;
grant execute on function public.admin_unsuspend_user(uuid) to authenticated;

create or replace function public.admin_list_appeals(p_status text default 'pending')
returns table (id uuid, user_id uuid, full_name text, username text, email text, message text, status text, created_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.am_i_configurer() then raise exception 'Configurer only'; end if;
  return query
    select a.id, a.user_id, p.full_name, p.username, p.email, a.message, a.status, a.created_at
    from public.account_appeals a join public.profiles p on p.id = a.user_id
    where (p_status is null or a.status = p_status)
    order by a.created_at asc;
end $$;
revoke all on function public.admin_list_appeals(text) from public, anon;
grant execute on function public.admin_list_appeals(text) to authenticated;

create or replace function public.admin_resolve_appeal(p_appeal uuid, p_approve boolean) returns void
language plpgsql security definer set search_path = public as $$
declare v_user uuid;
begin
  if not public.am_i_configurer() then raise exception 'Configurer only'; end if;
  select user_id into v_user from public.account_appeals where id = p_appeal and status = 'pending';
  if v_user is null then raise exception 'That appeal is not pending'; end if;
  update public.account_appeals set status = case when p_approve then 'approved' else 'denied' end,
    resolved_at = now(), resolved_by = auth.uid() where id = p_appeal;
  if p_approve then
    update public.profiles set suspended = false, suspended_reason = null where id = v_user;
  end if;
end $$;
revoke all on function public.admin_resolve_appeal(uuid, boolean) from public, anon;
grant execute on function public.admin_resolve_appeal(uuid, boolean) to authenticated;

-- ---------------------------------------------------------------------
-- Block a suspended person's writes at the point of entry (defense in depth -- the app itself already
-- stops them reaching the composer at all once profiles.suspended is true).
-- ---------------------------------------------------------------------
create or replace function public.ensure_conversation(p_other uuid) returns text
language plpgsql security definer set search_path = public as $$
declare a uuid; b uuid; cid text;
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  if public.i_am_suspended() then raise exception 'Your account is suspended'; end if;
  if p_other = auth.uid() then raise exception 'You cannot message yourself'; end if;
  if not exists (select 1 from public.profiles where id = p_other) then raise exception 'That user does not exist'; end if;
  a := least(auth.uid(), p_other); b := greatest(auth.uid(), p_other);
  cid := a::text || '__' || b::text;
  insert into public.conversations (id, user_a_id, user_b_id) values (cid, a, b) on conflict (id) do nothing;
  return cid;
end $$;

create or replace function public.send_message(p_conversation text, p_body text, p_attachment jsonb default null, p_by_ai boolean default false, p_reply_to uuid default null)
returns public.messages
language plpgsql security definer set search_path = public as $$
declare v_msg public.messages%rowtype; v_text text := btrim(coalesce(p_body, ''));
begin
  if public.i_am_suspended() then raise exception 'Your account is suspended'; end if;
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

create or replace function public.send_room_message(p_room uuid, p_body text, p_attachment jsonb default null, p_reply_to uuid default null)
returns public.room_messages
language plpgsql security definer set search_path = public as $$
declare v_msg public.room_messages%rowtype; v_text text := btrim(coalesce(p_body, ''));
begin
  if public.i_am_suspended() then raise exception 'Your account is suspended'; end if;
  if not public.i_am_room_member(p_room) then raise exception 'Not a member of this room'; end if;
  if v_text = '' and p_attachment is null then raise exception 'Empty message'; end if;
  if p_reply_to is not null and not exists (select 1 from public.room_messages where id = p_reply_to and room_id = p_room) then
    p_reply_to := null;
  end if;
  insert into public.room_messages (room_id, sender_id, body, attachment, reply_to_id) values (p_room, auth.uid(), v_text, p_attachment, p_reply_to) returning * into v_msg;
  return v_msg;
end $$;

create or replace function public.join_room(p_code text) returns uuid
language plpgsql security definer set search_path = public as $$
declare r public.rooms%rowtype;
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  if public.i_am_suspended() then raise exception 'Your account is suspended'; end if;
  select * into r from public.rooms where invite_code = p_code;
  if not found then raise exception 'This invitation link is not valid any more'; end if;
  if exists (select 1 from public.room_members where room_id = r.id and user_id = auth.uid()) then return r.id; end if;
  if (select count(*) from public.room_members where room_id = r.id) >= 250 then raise exception 'This room is full'; end if;
  insert into public.room_members (room_id, user_id) values (r.id, auth.uid());
  return r.id;
end $$;

create or replace function public.rooms_before_insert() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and new.owner_id <> auth.uid() then raise exception 'You can only create rooms for yourself'; end if;
  if public.i_am_suspended() then raise exception 'Your account is suspended'; end if;
  if (select count(*) from public.rooms where owner_id = new.owner_id) >= 20 then raise exception 'You can own up to 20 rooms. Delete one first.'; end if;
  new.name := btrim(new.name);
  return new;
end $$;

create or replace function public.toggle_message_reaction(p_message uuid, p_emoji text) returns void
language plpgsql security definer set search_path = public as $$
declare v_conv text; v_emoji text := left(btrim(p_emoji), 8);
begin
  if public.i_am_suspended() then raise exception 'Your account is suspended'; end if;
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

create or replace function public.toggle_room_message_reaction(p_message uuid, p_emoji text) returns void
language plpgsql security definer set search_path = public as $$
declare v_room uuid; v_emoji text := left(btrim(p_emoji), 8);
begin
  if public.i_am_suspended() then raise exception 'Your account is suspended'; end if;
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

create or replace function public.ai_send_message(p_conversation text, p_sender uuid, p_body text)
returns public.messages
language plpgsql security definer set search_path = public as $$
declare v_msg public.messages%rowtype; v_text text := left(btrim(coalesce(p_body, '')), 4000);
begin
  if coalesce((select suspended from public.profiles where id = p_sender), false) then
    raise exception 'That account is suspended';
  end if;
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

select 'migration 04 applied' as result;
