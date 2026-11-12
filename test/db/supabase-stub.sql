-- Minimal stand-ins for what Supabase provides, so schema.sql can be tested on plain Postgres.
create role anon nologin;
create role authenticated nologin;
create schema auth;
grant usage on schema auth to anon, authenticated;
grant usage on schema public to anon, authenticated;
create table auth.users (id uuid primary key, email text);
create function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant execute on function auth.uid() to anon, authenticated;
create publication supabase_realtime;
insert into auth.users values ('00000000-0000-0000-0000-000000000001', 'owner@example.com');
