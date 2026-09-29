-- The ai-compose and ai-reply Edge Functions read system_config using the service-role key, which
-- bypasses row-level security but still needs an ordinary table-level GRANT to read anything at all --
-- migration 00's `revoke all ... from anon, authenticated` never granted service_role access in the
-- first place, so both functions were getting a flat "permission denied for table system_config" and
-- silently reporting "AI is not set up yet" even once a real key was saved.
grant select on public.system_config to service_role;

select 'migration 05 applied' as result;
