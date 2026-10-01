-- 10: ForYou's administrator (the configurer) can delete an account and everything in it.
--
-- The admin panel calls the "delete-account" Edge Function (supabase/functions/delete-account). It
-- checks that the caller is the configurer, runs delete_account() below with the service role, then
-- removes the person's files from Storage, which only the Storage API can do.

create or replace function public.delete_account(p_user uuid) returns table (bucket text, path text)
language plpgsql security definer set search_path = public as $$
begin
  if p_user is null or not exists (select 1 from public.profiles where id = p_user) then
    raise exception 'That account does not exist';
  end if;
  if (select is_configurer from public.profiles where id = p_user) then
    raise exception 'The administrator account cannot be deleted';
  end if;

  -- Groups they made pass to whoever has been in them longest. A group with nobody else in it goes.
  update public.rooms r set owner_id = (
      select m.user_id from public.room_members m
      where m.room_id = r.id and m.user_id <> p_user
      order by m.joined_at, m.id limit 1)
    where r.owner_id = p_user
      and exists (select 1 from public.room_members m where m.room_id = r.id and m.user_id <> p_user);

  -- The files to remove afterwards: their profile photo, everything shared in their one-to-one chats
  -- and in the groups that go with them, and what they sent in the groups that stay.
  return query
    select distinct o.bucket_id::text, o.name::text from storage.objects o
    where (o.bucket_id = 'avatars' and (storage.foldername(o.name))[1] = p_user::text)
       or (o.bucket_id = 'attachments' and (
             (storage.foldername(o.name))[1] in (select c.id from public.conversations c where p_user in (c.user_a_id, c.user_b_id))
          or (storage.foldername(o.name))[1] in (select 'room-' || r.id::text from public.rooms r where r.owner_id = p_user)
          or o.name in (select rm.attachment ->> 'path' from public.room_messages rm
                        where rm.sender_id = p_user and rm.attachment ? 'path')));

  update public.account_appeals set resolved_by = null where resolved_by = p_user;
  -- Deleting the sign-in deletes the profile, and with it their chats, messages, reactions, group
  -- memberships, blind dates, appeals and phone codes (all "on delete cascade").
  delete from auth.users where id = p_user;
end $$;
revoke all on function public.delete_account(uuid) from public, anon, authenticated;
grant execute on function public.delete_account(uuid) to service_role;

select 'migration 10 applied' as result;
