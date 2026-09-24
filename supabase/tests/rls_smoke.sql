-- RLS smoke test for the init schema. Runs in a transaction and rolls back,
-- so it leaves no data behind. Any failed assertion raises and aborts.

begin;

-- Fixtures (as the migration owner, bypassing RLS).
insert into public.users (id, google_id, email, access_token_enc, refresh_token_enc, token_expires_at)
values
  ('00000000-0000-0000-0000-00000000000a', 'google-a', 'rls-a@example.test', '\x00', '\x00', now() + interval '1 hour'),
  ('00000000-0000-0000-0000-00000000000b', 'google-b', 'rls-b@example.test', '\x00', '\x00', now() + interval '1 hour');

insert into public.messages
  (user_id, id, thread_id, subject, from_address, to_address, snippet, label_ids, received_at, history_id)
values
  ('00000000-0000-0000-0000-00000000000a', 'msg-a', 't-a', 's', 'f', 't', 'x', '{INBOX,UNREAD}', now(), 1),
  ('00000000-0000-0000-0000-00000000000b', 'msg-b', 't-b', 's', 'f', 't', 'x', '{INBOX,UNREAD}', now(), 1);

insert into public.oauth_states (state) values ('rls-state');
insert into public.webhook_events (message_id, email_address, history_id) values ('rls-evt', 'rls-a@example.test', 1);

-- is_read is derived from label_ids.
do $$
begin
  assert (select not is_read from public.messages where id = 'msg-a'), 'is_read should be false while UNREAD present';
  update public.messages set label_ids = array_remove(label_ids, 'UNREAD') where id = 'msg-a';
  assert (select is_read from public.messages where id = 'msg-a'), 'is_read should flip to true when UNREAD removed';
end $$;

-- ---------------------------------------------------------------------------
-- As user A
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated"}', true);

do $$
declare n int;
begin
  assert (select count(*) from public.users) = 1, 'A should see exactly one user row';
  assert (select id from public.users) = '00000000-0000-0000-0000-00000000000a', 'A should see only own user row';
  assert (select count(*) from public.messages) = 1, 'A should see exactly one message';
  assert (select id from public.messages) = 'msg-a', 'A should see only own message';

  update public.messages set label_ids = '{}' where id = 'msg-b';
  get diagnostics n = row_count;
  assert n = 0, 'A must not update B''s message';

  delete from public.messages where id = 'msg-b';
  get diagnostics n = row_count;
  assert n = 0, 'A must not delete B''s message';

  update public.users set token_expires_at = now() where id = '00000000-0000-0000-0000-00000000000b';
  get diagnostics n = row_count;
  assert n = 0, 'A must not update B''s user row';

  update public.users set last_history_id = 42 where id = '00000000-0000-0000-0000-00000000000a';
  get diagnostics n = row_count;
  assert n = 1, 'A should be able to update own sync columns';

  begin
    insert into public.messages
      (user_id, id, thread_id, subject, from_address, to_address, snippet, received_at, history_id)
    values ('00000000-0000-0000-0000-00000000000b', 'msg-x', 't', 's', 'f', 't', 'x', now(), 1);
    raise exception 'A must not insert a message owned by B';
  exception when insufficient_privilege then null;
  end;

  begin
    update public.messages set user_id = '00000000-0000-0000-0000-00000000000b' where id = 'msg-a';
    raise exception 'A must not reassign own message to B';
  exception when insufficient_privilege then null;
  end;

  begin
    update public.users set email = 'hijack@example.test' where id = '00000000-0000-0000-0000-00000000000a';
    raise exception 'A must not change own email';
  exception when insufficient_privilege then null;
  end;

  begin
    insert into public.users (google_id, email, access_token_enc, refresh_token_enc, token_expires_at)
    values ('google-new', 'new@example.test', '\x00', '\x00', now());
    raise exception 'authenticated must not insert users';
  exception when insufficient_privilege then null;
  end;

  begin
    perform 1 from public.oauth_states;
    raise exception 'authenticated must not read oauth_states';
  exception when insufficient_privilege then null;
  end;

  begin
    perform 1 from public.webhook_events;
    raise exception 'authenticated must not read webhook_events';
  exception when insufficient_privilege then null;
  end;
end $$;

-- ---------------------------------------------------------------------------
-- As anon
-- ---------------------------------------------------------------------------
reset role;
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);

do $$
declare t text;
begin
  foreach t in array array['users', 'messages', 'oauth_states', 'webhook_events'] loop
    begin
      execute format('select 1 from public.%I', t);
      raise exception 'anon must not read %', t;
    exception when insufficient_privilege then null;
    end;
  end loop;
end $$;

reset role;
select 'RLS smoke test passed' as result;

rollback;
