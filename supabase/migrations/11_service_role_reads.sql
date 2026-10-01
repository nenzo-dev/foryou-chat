-- 11: the server-side services (Edge Functions) can read the tables they work with.
--
-- This project's tables were never granted to service_role (see 05, which fixed system_config
-- alone). So ai-reply couldn't read profiles or messages and skipped every auto-reply as "Auto-reply
-- is off", and push couldn't read who to notify. The service role key only ever lives in Supabase's
-- own Edge Functions, never in the app.

grant select on public.profiles, public.messages, public.conversations, public.rooms,
  public.room_members, public.room_messages, public.device_tokens to service_role;
-- push forgets phone tokens Firebase says are gone, and nothing else.
grant update (fcm_token) on public.device_tokens to service_role;

select 'migration 11 applied' as result;
