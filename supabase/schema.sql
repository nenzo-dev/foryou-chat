-- =====================================================================
-- ForYou: a public chat app (1-1 messaging, group rooms, video calls with
-- screen share, optional AI auto-reply). Schema for Supabase (Postgres).
--
-- Reuses the same concepts as MindCare's own messaging/rooms/presence/video
-- system (conversations+messages, rooms+room_members+room_messages+
-- room_call_members, user_presence, WebRTC signalling over Realtime), but
-- as a clean, role-free schema: ForYou has no therapist/client distinction,
-- any two people can message each other.
--
-- HOW TO USE
--   1. Create a free project at supabase.com.
--   2. Open SQL Editor, paste this whole file and press Run.
--   3. Paste your Project URL and anon key into js/config.js.
--   4. Open the app, "Create account" -- the very first account to sign up
--      becomes the app's configurer (can paste the AI key in Settings >
--      AI setup, the only "admin" concept ForYou has).
-- =====================================================================

create extension if not exists pg_net;

grant usage on schema public to anon, authenticated;

-- ---------------------------------------------------------------------
-- PROFILES
-- ---------------------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  full_name text not null default '',
  username text unique,
  bio text not null default '',
  avatar_path text,
  avatar_color text not null default '#F5C400',
  is_configurer boolean not null default false,
  ai_auto_reply boolean not null default false,
  prefs jsonb not null default '{"show_online": true}'::jsonb,
  created_at timestamptz not null default now(),
  constraint username_format check (username is null or username ~ '^[a-z0-9_.]{3,24}$')
);
create index if not exists profiles_username_idx on public.profiles (username);

alter table public.profiles enable row level security;
grant select, insert on public.profiles to authenticated;
grant update (full_name, username, bio, avatar_path, avatar_color, ai_auto_reply, prefs) on public.profiles to authenticated;

create policy profiles_select on public.profiles for select to authenticated using (true);
create policy profiles_insert on public.profiles for insert to authenticated with check (id = auth.uid());
create policy profiles_update on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

create or replace function public.claim_configurer() returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return false; end if;
  if exists (select 1 from public.profiles where is_configurer) then return false; end if;
  update public.profiles set is_configurer = true where id = auth.uid();
  return true;
end $$;
revoke all on function public.claim_configurer() from public, anon;
grant execute on function public.claim_configurer() to authenticated;

create or replace function public.am_i_configurer() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select is_configurer from public.profiles where id = auth.uid()), false);
$$;
grant execute on function public.am_i_configurer() to authenticated;

create or replace function public.find_user_by_username(p_username text)
returns table (id uuid, full_name text, username text, bio text, avatar_path text, avatar_color text)
language sql stable security definer set search_path = public as $$
  select id, full_name, username, bio, avatar_path, avatar_color
  from public.profiles where username = lower(btrim(p_username)) and id <> auth.uid();
$$;
grant execute on function public.find_user_by_username(text) to authenticated;

-- ---------------------------------------------------------------------
-- SHARED APP CONFIG (the AI key -- never readable from the browser)
-- ---------------------------------------------------------------------
create table if not exists public.system_config (
  id int primary key default 1 check (id = 1),
  ai_provider text not null default 'anthropic',
  ai_api_key text,
  ai_model text,
  updated_at timestamptz not null default now()
);
insert into public.system_config (id) values (1) on conflict (id) do nothing;
alter table public.system_config enable row level security;
revoke all on public.system_config from anon, authenticated;

create or replace function public.admin_set_ai_key(p_key text, p_provider text default 'anthropic', p_model text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.am_i_configurer() then raise exception 'Only the configurer can set this.'; end if;
  update public.system_config set ai_api_key = nullif(btrim(p_key), ''), ai_provider = coalesce(nullif(btrim(p_provider), ''), 'anthropic'),
    ai_model = nullif(btrim(coalesce(p_model, '')), ''), updated_at = now() where id = 1;
end $$;
grant execute on function public.admin_set_ai_key(text, text, text) to authenticated;

create or replace function public.ai_key_status()
returns table (configured boolean, provider text, model text)
language sql stable security definer set search_path = public as $$
  select (ai_api_key is not null and ai_api_key <> ''), ai_provider, ai_model from public.system_config where id = 1;
$$;
grant execute on function public.ai_key_status() to authenticated;

-- ---------------------------------------------------------------------
-- PRESENCE (who is online)
-- ---------------------------------------------------------------------
create table if not exists public.user_presence (
  id uuid primary key references public.profiles(id) on delete cascade,
  last_seen timestamptz not null default now(),
  in_call boolean not null default false
);
alter table public.user_presence enable row level security;
revoke all on public.user_presence from anon, authenticated;

create or replace function public.touch_seen(p_in_call boolean default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return; end if;
  insert into public.user_presence (id, last_seen, in_call) values (auth.uid(), now(), coalesce(p_in_call, false))
  on conflict (id) do update set last_seen = now(), in_call = coalesce(p_in_call, public.user_presence.in_call);
end $$;
grant execute on function public.touch_seen(boolean) to authenticated;

-- ---------------------------------------------------------------------
-- 1-1 MESSAGING
-- ---------------------------------------------------------------------
create table if not exists public.conversations (
  id text primary key,
  user_a_id uuid not null references public.profiles(id) on delete cascade,
  user_b_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  last_message_at timestamptz not null default now(),
  last_message_preview text not null default '',
  check (user_a_id < user_b_id)
);
create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id text not null references public.conversations(id) on delete cascade,
  sender_id uuid not null references public.profiles(id) on delete cascade,
  body text not null default '' check (char_length(body) <= 4000),
  attachment jsonb,
  sent_by_ai boolean not null default false,
  created_at timestamptz not null default now(),
  read_at timestamptz
);
create index if not exists messages_conv_idx on public.messages (conversation_id, created_at);

alter table public.conversations enable row level security;
alter table public.messages enable row level security;
grant select on public.conversations to authenticated;
grant select, insert on public.messages to authenticated;
grant update (read_at) on public.messages to authenticated;

create or replace function public.i_am_participant(conv text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.conversations where id = conv and auth.uid() in (user_a_id, user_b_id));
$$;

create policy conv_select on public.conversations for select to authenticated using (auth.uid() in (user_a_id, user_b_id));
create policy msg_select on public.messages for select to authenticated using (public.i_am_participant(conversation_id));
create policy msg_insert on public.messages for insert to authenticated with check (sender_id = auth.uid() and public.i_am_participant(conversation_id));
create policy msg_update on public.messages for update to authenticated using (public.i_am_participant(conversation_id) and sender_id <> auth.uid()) with check (public.i_am_participant(conversation_id));

create or replace function public.ensure_conversation(p_other uuid) returns text
language plpgsql security definer set search_path = public as $$
declare a uuid; b uuid; cid text;
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  if p_other = auth.uid() then raise exception 'You cannot message yourself'; end if;
  if not exists (select 1 from public.profiles where id = p_other) then raise exception 'That user does not exist'; end if;
  a := least(auth.uid(), p_other); b := greatest(auth.uid(), p_other);
  cid := a::text || '__' || b::text;
  insert into public.conversations (id, user_a_id, user_b_id) values (cid, a, b) on conflict (id) do nothing;
  return cid;
end $$;
grant execute on function public.ensure_conversation(uuid) to authenticated;

create or replace function public.my_conversations()
returns table (id text, other_id uuid, other_name text, other_username text, other_avatar_path text, other_avatar_color text,
               last_message_at timestamptz, last_message_preview text, unread int)
language sql stable security definer set search_path = public as $$
  select c.id, p.id, p.full_name, p.username, p.avatar_path, p.avatar_color, c.last_message_at, c.last_message_preview,
    (select count(*)::int from public.messages m where m.conversation_id = c.id and m.read_at is null and m.sender_id <> auth.uid())
  from public.conversations c
  join public.profiles p on p.id = (case when c.user_a_id = auth.uid() then c.user_b_id else c.user_a_id end)
  where auth.uid() in (c.user_a_id, c.user_b_id)
  order by c.last_message_at desc;
$$;
grant execute on function public.my_conversations() to authenticated;

create or replace function public.send_message(p_conversation text, p_body text, p_attachment jsonb default null, p_by_ai boolean default false)
returns public.messages
language plpgsql security definer set search_path = public as $$
declare v_msg public.messages%rowtype; v_text text := btrim(coalesce(p_body, ''));
begin
  if not public.i_am_participant(p_conversation) then raise exception 'Not your conversation'; end if;
  if v_text = '' and p_attachment is null then raise exception 'Empty message'; end if;
  insert into public.messages (conversation_id, sender_id, body, attachment, sent_by_ai)
    values (p_conversation, auth.uid(), v_text, p_attachment, coalesce(p_by_ai, false))
    returning * into v_msg;
  update public.conversations set last_message_at = v_msg.created_at,
    last_message_preview = left(coalesce(nullif(v_text, ''), case when p_attachment ->> 'type' like 'audio/%' then 'Voice message' else 'Attachment' end), 90)
    where id = p_conversation;
  perform public.maybe_ai_reply(p_conversation, v_msg.id);
  return v_msg;
end $$;
grant execute on function public.send_message(text, text, jsonb, boolean) to authenticated;

create or replace function public.mark_conversation_read(p_conversation text) returns void
language sql security definer set search_path = public as $$
  update public.messages set read_at = now()
  where conversation_id = p_conversation and read_at is null and sender_id <> auth.uid() and public.i_am_participant(p_conversation);
$$;
grant execute on function public.mark_conversation_read(text) to authenticated;
-- ---------------------------------------------------------------------
-- ROOMS (group chat + group video, same design as MindCare's)
-- ---------------------------------------------------------------------
create table if not exists public.rooms (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 2 and 60),
  topic text not null default '' check (char_length(topic) <= 200),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  invite_code text not null unique default replace(gen_random_uuid()::text, '-', ''),
  call_secret text not null default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
  created_at timestamptz not null default now(),
  last_message_at timestamptz not null default now(),
  last_message_preview text not null default ''
);
create table if not exists public.room_members (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  joined_at timestamptz not null default now(),
  last_read_at timestamptz not null default now(),
  unique (room_id, user_id)
);
create index if not exists room_members_user_idx on public.room_members (user_id);
create table if not exists public.room_messages (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  sender_id uuid not null references public.profiles(id) on delete cascade,
  body text not null default '' check (char_length(body) <= 4000),
  attachment jsonb,
  created_at timestamptz not null default now()
);
create index if not exists room_messages_room_idx on public.room_messages (room_id, created_at);
create table if not exists public.room_call_members (
  room_id uuid not null references public.rooms(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  joined_at timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  primary key (room_id, user_id)
);
alter table public.rooms enable row level security;
alter table public.room_members enable row level security;
alter table public.room_messages enable row level security;
alter table public.room_call_members enable row level security;
grant select, insert, delete on public.rooms to authenticated;
grant update (name, topic) on public.rooms to authenticated;
grant select, insert, delete on public.room_members to authenticated;
grant update (last_read_at) on public.room_members to authenticated;
grant select, insert, delete on public.room_messages to authenticated;

create or replace function public.i_am_room_member(r uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.room_members where room_id = r and user_id = auth.uid());
$$;
create or replace function public.i_own_room(r uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.rooms where id = r and owner_id = auth.uid());
$$;

create or replace function public.rooms_before_insert() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and new.owner_id <> auth.uid() then raise exception 'You can only create rooms for yourself'; end if;
  if (select count(*) from public.rooms where owner_id = new.owner_id) >= 20 then raise exception 'You can own up to 20 rooms. Delete one first.'; end if;
  new.name := btrim(new.name);
  return new;
end $$;
drop trigger if exists rooms_bi on public.rooms;
create trigger rooms_bi before insert on public.rooms for each row execute function public.rooms_before_insert();

create or replace function public.rooms_after_insert() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.room_members (room_id, user_id) values (new.id, new.owner_id) on conflict (room_id, user_id) do nothing;
  return new;
end $$;
drop trigger if exists rooms_ai on public.rooms;
create trigger rooms_ai after insert on public.rooms for each row execute function public.rooms_after_insert();

create or replace function public.room_messages_after_insert() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update public.rooms set last_message_at = new.created_at,
    last_message_preview = left(coalesce(nullif(btrim(new.body), ''), case when new.attachment ->> 'type' like 'audio/%' then 'Voice message' else 'Attachment' end), 90)
  where id = new.room_id;
  return new;
end $$;
drop trigger if exists room_messages_ai on public.room_messages;
create trigger room_messages_ai after insert on public.room_messages for each row execute function public.room_messages_after_insert();

create or replace function public.room_invite_preview(p_code text)
returns table (name text, topic text, members int, already boolean)
language sql stable security definer set search_path = public as $$
  select r.name, r.topic, (select count(*)::int from public.room_members m where m.room_id = r.id),
         exists (select 1 from public.room_members m where m.room_id = r.id and m.user_id = auth.uid())
  from public.rooms r where auth.uid() is not null and r.invite_code = p_code;
$$;

create or replace function public.join_room(p_code text) returns uuid
language plpgsql security definer set search_path = public as $$
declare r public.rooms%rowtype;
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  select * into r from public.rooms where invite_code = p_code;
  if not found then raise exception 'This invitation link is not valid any more'; end if;
  if exists (select 1 from public.room_members where room_id = r.id and user_id = auth.uid()) then return r.id; end if;
  if (select count(*) from public.room_members where room_id = r.id) >= 250 then raise exception 'This room is full'; end if;
  insert into public.room_members (room_id, user_id) values (r.id, auth.uid());
  return r.id;
end $$;

create or replace function public.room_people(p_room uuid)
returns table (user_id uuid, full_name text, username text, avatar_path text, avatar_color text, is_owner boolean, joined_at timestamptz, last_seen timestamptz)
language sql stable security definer set search_path = public as $$
  select m.user_id, p.full_name, p.username, p.avatar_path, p.avatar_color, m.user_id = r.owner_id, m.joined_at,
         case when m.user_id = auth.uid() then null
              when coalesce((p.prefs ->> 'show_online')::boolean, true) then u.last_seen
              else null end
  from public.room_members m
  join public.rooms r on r.id = m.room_id
  join public.profiles p on p.id = m.user_id
  left join public.user_presence u on u.id = m.user_id
  where m.room_id = p_room and public.i_am_room_member(p_room)
  order by (m.user_id = r.owner_id) desc, m.joined_at;
$$;

create or replace function public.my_rooms()
returns table (id uuid, name text, topic text, owner_id uuid, last_message_at timestamptz, last_message_preview text, unread int, members int)
language sql stable security definer set search_path = public as $$
  select r.id, r.name, r.topic, r.owner_id, r.last_message_at, r.last_message_preview,
    (select count(x.id)::int from public.room_messages x where x.room_id = r.id and x.created_at > m.last_read_at and x.sender_id <> auth.uid()),
    (select count(*)::int from public.room_members mm where mm.room_id = r.id)
  from public.rooms r join public.room_members m on m.room_id = r.id and m.user_id = auth.uid()
  order by r.last_message_at desc;
$$;
grant execute on function public.my_rooms() to authenticated;

create or replace function public.send_room_message(p_room uuid, p_body text, p_attachment jsonb default null)
returns public.room_messages
language plpgsql security definer set search_path = public as $$
declare v_msg public.room_messages%rowtype; v_text text := btrim(coalesce(p_body, ''));
begin
  if not public.i_am_room_member(p_room) then raise exception 'Not a member of this room'; end if;
  if v_text = '' and p_attachment is null then raise exception 'Empty message'; end if;
  insert into public.room_messages (room_id, sender_id, body, attachment) values (p_room, auth.uid(), v_text, p_attachment) returning * into v_msg;
  return v_msg;
end $$;
grant execute on function public.send_room_message(uuid, text, jsonb) to authenticated;

create or replace function public.reset_room_invite(p_room uuid) returns text
language plpgsql security definer set search_path = public as $$
declare c text := replace(gen_random_uuid()::text, '-', '');
begin
  if not public.i_own_room(p_room) then raise exception 'Only the owner can do that'; end if;
  update public.rooms set invite_code = c where id = p_room;
  return c;
end $$;

create or replace function public.mark_room_read(p_room uuid) returns void
language sql security definer set search_path = public as $$
  update public.room_members set last_read_at = now() where room_id = p_room and user_id = auth.uid();
$$;

create or replace function public.leave_room(p_room uuid) returns void
language sql security definer set search_path = public as $$
  delete from public.room_members where room_id = p_room and user_id = auth.uid();
$$;
create or replace function public.remove_room_member(p_room uuid, p_user uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.i_own_room(p_room) then raise exception 'Only the owner can do that'; end if;
  delete from public.room_members where room_id = p_room and user_id = p_user;
end $$;
create or replace function public.delete_room(p_room uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.i_own_room(p_room) then raise exception 'Only the owner can do that'; end if;
  delete from public.rooms where id = p_room;
end $$;

create or replace function public.join_room_call(p_room uuid) returns text
language plpgsql security definer set search_path = public as $$
declare s text; n int;
begin
  if not public.i_am_room_member(p_room) then raise exception 'You are not in this room'; end if;
  select call_secret into s from public.rooms where id = p_room for update;
  delete from public.room_call_members where room_id = p_room and last_seen < now() - interval '45 seconds';
  if exists (select 1 from public.room_call_members where room_id = p_room and user_id = auth.uid()) then
    update public.room_call_members set last_seen = now() where room_id = p_room and user_id = auth.uid();
  else
    select count(*) into n from public.room_call_members where room_id = p_room;
    if n >= 8 then raise exception 'This call is full. Up to 8 people can be on a call.'; end if;
    insert into public.room_call_members (room_id, user_id) values (p_room, auth.uid());
  end if;
  return s;
end $$;
create or replace function public.leave_room_call(p_room uuid) returns void
language sql security definer set search_path = public as $$
  delete from public.room_call_members where room_id = p_room and user_id = auth.uid();
$$;
create or replace function public.room_call_people(p_room uuid)
returns table (user_id uuid, full_name text)
language sql stable security definer set search_path = public as $$
  select c.user_id, p.full_name from public.room_call_members c join public.profiles p on p.id = c.user_id
  where c.room_id = p_room and c.last_seen > now() - interval '45 seconds' and public.i_am_room_member(p_room)
  order by c.joined_at;
$$;
create or replace function public.room_calls() returns table (room_id uuid, people int)
language sql stable security definer set search_path = public as $$
  select c.room_id, count(*)::int from public.room_call_members c
  where c.last_seen > now() - interval '45 seconds' and public.i_am_room_member(c.room_id) group by c.room_id;
$$;

revoke all on function
  public.room_invite_preview(text), public.join_room(text), public.room_people(uuid), public.reset_room_invite(uuid),
  public.mark_room_read(uuid), public.leave_room(uuid), public.remove_room_member(uuid, uuid), public.delete_room(uuid),
  public.join_room_call(uuid), public.leave_room_call(uuid), public.room_call_people(uuid), public.room_calls()
  from public, anon;
grant execute on function
  public.room_invite_preview(text), public.join_room(text), public.room_people(uuid), public.reset_room_invite(uuid),
  public.mark_room_read(uuid), public.leave_room(uuid), public.remove_room_member(uuid, uuid), public.delete_room(uuid),
  public.join_room_call(uuid), public.leave_room_call(uuid), public.room_call_people(uuid), public.room_calls()
  to authenticated;

create policy rooms_select on public.rooms for select to authenticated using (owner_id = auth.uid() or public.i_am_room_member(id));
create policy rooms_insert on public.rooms for insert to authenticated with check (owner_id = auth.uid());
create policy rooms_update on public.rooms for update to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy rooms_delete on public.rooms for delete to authenticated using (owner_id = auth.uid());

create policy room_members_select on public.room_members for select to authenticated using (public.i_am_room_member(room_id));
create policy room_members_update on public.room_members for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy room_members_delete on public.room_members for delete to authenticated
  using ((user_id = auth.uid() and not public.i_own_room(room_id)) or (public.i_own_room(room_id) and user_id <> auth.uid()));

create policy room_messages_select on public.room_messages for select to authenticated using (public.i_am_room_member(room_id));
create policy room_messages_insert on public.room_messages for insert to authenticated with check (sender_id = auth.uid() and public.i_am_room_member(room_id));
create policy room_messages_delete on public.room_messages for delete to authenticated using (sender_id = auth.uid() or public.i_own_room(room_id));

create or replace function public.contacts_presence()
returns table (user_id uuid, last_seen timestamptz, in_call boolean)
language sql stable security definer set search_path = public as $$
  select u.id, u.last_seen, u.in_call
  from public.user_presence u join public.profiles p on p.id = u.id
  where auth.uid() is not null and u.id <> auth.uid()
    and coalesce((p.prefs ->> 'show_online')::boolean, true)
    and (exists (select 1 from public.conversations c where auth.uid() in (c.user_a_id, c.user_b_id) and u.id in (c.user_a_id, c.user_b_id))
         or exists (select 1 from public.room_members a join public.room_members b on b.room_id = a.room_id
                    where a.user_id = auth.uid() and b.user_id = u.id));
$$;
grant execute on function public.contacts_presence() to authenticated;
-- ---------------------------------------------------------------------
-- STORAGE (avatars + chat attachments)
-- ---------------------------------------------------------------------
grant usage on schema storage to anon, authenticated;
grant select, insert, update, delete on storage.objects to anon, authenticated;
grant select on storage.buckets to anon, authenticated;

insert into storage.buckets (id, name, public) values ('avatars', 'avatars', true) on conflict (id) do nothing;
insert into storage.buckets (id, name, public) values ('attachments', 'attachments', false) on conflict (id) do nothing;

create policy avatars_read on storage.objects for select using (bucket_id = 'avatars');
create policy avatars_write on storage.objects for insert to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
create policy avatars_update on storage.objects for update to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
create policy avatars_delete on storage.objects for delete to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

create or replace function public.attachment_folder_ok(folder text) returns boolean
language sql stable security definer set search_path = public as $$
  select case when folder ~ '^room-[0-9a-f-]{36}$' then public.i_am_room_member(substr(folder, 6)::uuid)
              else public.i_am_participant(folder) end;
$$;
create policy attachments_read on storage.objects for select to authenticated
  using (bucket_id = 'attachments' and public.attachment_folder_ok((storage.foldername(name))[1]));
create policy attachments_write on storage.objects for insert to authenticated
  with check (bucket_id = 'attachments' and public.attachment_folder_ok((storage.foldername(name))[1]));

-- ---------------------------------------------------------------------
-- AI AUTO-REPLY (opt-in, per user, transparently tagged)
-- ---------------------------------------------------------------------
create or replace function public.maybe_ai_reply(p_conversation text, p_message_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_other uuid; v_sender uuid; v_by_ai boolean;
  -- Supabase's managed Postgres refuses "alter database ... set" (needs superuser), so this project's
  -- own Edge Functions base URL is just hardcoded here instead of read from a custom GUC.
  v_base text := 'https://mkcyowrofmrlnmlypjou.supabase.co/functions/v1';
begin
  select sender_id, sent_by_ai into v_sender, v_by_ai from public.messages where id = p_message_id;
  if v_by_ai then return; end if;
  select case when user_a_id = v_sender then user_b_id else user_a_id end into v_other
    from public.conversations where id = p_conversation;
  if v_other is null or not exists (select 1 from public.profiles where id = v_other and ai_auto_reply) then return; end if;
  if v_base is null or v_base = '' then return; end if;
  perform net.http_post(
    url := v_base || '/ai-reply',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body := jsonb_build_object('conversation_id', p_conversation, 'message_id', p_message_id, 'reply_as', v_other)
  );
end $$;

select 'schema applied' as result;
