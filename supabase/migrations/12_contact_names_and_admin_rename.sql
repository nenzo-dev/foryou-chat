-- 12: names you give your contacts (only you see them), and the configurer changing anyone's public name.
-- Safe to run more than once.

-- Your own name for someone, like saving a contact in your phone. Only the owner can read or change it.
create table if not exists public.contact_names (
  owner_id uuid not null references public.profiles(id) on delete cascade,
  contact_id uuid not null references public.profiles(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 60),
  updated_at timestamptz not null default now(),
  primary key (owner_id, contact_id)
);
alter table public.contact_names enable row level security;
grant select, insert, update, delete on public.contact_names to authenticated;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'contact_names' and policyname = 'contact_names_own') then
    create policy contact_names_own on public.contact_names for all to authenticated
      using (owner_id = auth.uid())
      with check (owner_id = auth.uid() and contact_id <> auth.uid());
  end if;
end $$;
-- push shows your name for the person in the notification on your phone.
grant select on public.contact_names to service_role;

-- The configurer can change the name and username everyone else sees.
create or replace function public.admin_rename_user(p_user uuid, p_full_name text, p_username text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_name text := btrim(coalesce(p_full_name, ''));
  v_username text := nullif(lower(btrim(coalesce(p_username, ''))), '');
begin
  if not public.am_i_configurer() then raise exception 'Only the configurer can do this.' using hint = 'fy:show'; end if;
  if v_name = '' then raise exception 'Enter a name.' using hint = 'fy:show'; end if;
  if char_length(v_name) > 60 then raise exception 'That name is too long.' using hint = 'fy:show'; end if;
  if v_username is not null and v_username !~ '^[a-z0-9_.]{3,24}$' then
    raise exception 'Username: 3-24 characters, lowercase letters, numbers, "." or "_" only.' using hint = 'fy:show';
  end if;
  if v_username is not null and exists (select 1 from public.profiles where username = v_username and id <> p_user) then
    raise exception 'That username is taken.' using hint = 'fy:show';
  end if;
  update public.profiles set full_name = v_name, username = v_username where id = p_user;
  if not found then raise exception 'That account does not exist.' using hint = 'fy:show'; end if;
end $$;
revoke all on function public.admin_rename_user(uuid, text, text) from public, anon;
grant execute on function public.admin_rename_user(uuid, text, text) to authenticated;

select 'migration 12 applied' as result;
