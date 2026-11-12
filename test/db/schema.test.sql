\set ON_ERROR_STOP on
-- Assertion helper
create function pg_temp.expect(cond boolean, msg text) returns void language plpgsql as
  $$ begin if not coalesce(cond, false) then raise exception 'FAIL: %', msg; end if; raise notice 'PASS: %', msg; end $$;
-- Expect a statement to fail with a message matching a pattern
create function pg_temp.expect_error(stmt text, pattern text, msg text) returns void language plpgsql as $$
begin
  begin execute stmt; exception when others then
    if sqlerrm ~* pattern then raise notice 'PASS: % (%)', msg, sqlerrm; return; end if;
    raise exception 'FAIL: % — wrong error: %', msg, sqlerrm;
  end;
  raise exception 'FAIL: % — no error raised', msg;
end $$;
grant execute on all functions in schema pg_temp to anon, authenticated;

-- ---------- anonymous visitors see nothing ----------
set role anon;
select pg_temp.expect_error('select * from public.items', 'permission denied', 'anon cannot read items');
select pg_temp.expect_error('select * from public.sales', 'permission denied', 'anon cannot read sales');
select pg_temp.expect_error($$select public.sell_item(gen_random_uuid(), 1, 60)$$, 'permission denied', 'anon cannot sell');
reset role;

-- ---------- signed-in user ----------
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000001';

insert into public.items (id, name, quantity, acquired_amount_usd, selling_price_php)
values ('11111111-1111-1111-1111-111111111111', 'Pen', 3, 2.50, 200);
select pg_temp.expect((select in_stock from public.items where name = 'Pen'), 'item in stock when qty > 0');

select pg_temp.expect_error($$insert into public.items (name, quantity, acquired_amount_usd, selling_price_php) values ('X', -1, 1, 1)$$, 'check', 'negative qty rejected');
select pg_temp.expect_error($$insert into public.items (name, quantity, acquired_amount_usd, selling_price_php) values ('   ', 1, 1, 1)$$, 'check', 'blank name rejected');
select pg_temp.expect_error($$insert into public.items (name, quantity, acquired_amount_usd, selling_price_php) values ('X', 1, 1, -5)$$, 'check', 'negative price rejected');
select pg_temp.expect_error($$insert into public.sales (item_name, quantity, unit_price_php, total_php, acquired_amount_usd) values ('fake', 1, 1, 1, 1)$$, 'permission denied', 'cannot insert sales directly');

-- Sell 2 at rate 60: cost PHP 150, price 200 -> markup 50, total 400
create temp table s1 as select * from public.sell_item('11111111-1111-1111-1111-111111111111', 2, 60);
select pg_temp.expect((select markup_php = 50 and total_php = 400 and quantity = 2 and usd_to_php = 60 from s1), 'sale snapshot + markup');
select pg_temp.expect((select sold_by = '00000000-0000-0000-0000-000000000001' from s1), 'sold_by recorded');
select pg_temp.expect((select quantity = 1 from public.items where name = 'Pen'), 'stock decremented');

select pg_temp.expect_error($$select public.sell_item('11111111-1111-1111-1111-111111111111', 5, 60)$$, 'Only 1 in stock', 'oversell rejected');
select pg_temp.expect_error($$select public.sell_item('11111111-1111-1111-1111-111111111111', 0, 60)$$, 'at least 1', 'zero qty rejected');
select pg_temp.expect_error($$select public.sell_item(gen_random_uuid(), 1, 60)$$, 'Item not found', 'unknown item');

-- Last unit, rate unavailable -> markup null, out of stock
create temp table s2 as select * from public.sell_item('11111111-1111-1111-1111-111111111111', 1, null);
select pg_temp.expect((select markup_php is null from s2), 'null markup when no rate');
select pg_temp.expect((select not in_stock from public.items where name = 'Pen'), 'out of stock at qty 0');

-- Selling below cost -> negative markup
insert into public.items (id, name, quantity, acquired_amount_usd, selling_price_php)
values ('22222222-2222-2222-2222-222222222222', 'Mug', 1, 2, 100);
select pg_temp.expect((select markup_php = -20 from public.sell_item('22222222-2222-2222-2222-222222222222', 1, 60)), 'negative markup');

-- Void restores stock
select public.void_sale((select id from s1));
select pg_temp.expect((select quantity = 2 from public.items where name = 'Pen'), 'void restores stock');
select pg_temp.expect_error(format('select public.void_sale(%L)', (select id from s1)), 'Sale not found', 'double void rejected');

-- Deleting an item keeps its sales; voiding them still works
delete from public.items where name = 'Pen';
select pg_temp.expect((select item_id is null and item_name = 'Pen' from public.sales where id = (select id from s2)), 'history survives item delete');
select public.void_sale((select id from s2));
select pg_temp.expect(not exists (select 1 from public.sales where id = (select id from s2)), 'void after delete works');

-- updated_at trigger
reset role;
update public.items set updated_at = '2000-01-01' where name = 'Mug';
set role authenticated;
update public.items set quantity = 5 where name = 'Mug';
select pg_temp.expect((select updated_at > '2001-01-01' from public.items where name = 'Mug'), 'updated_at touched');

-- Signed-out session (authenticated role but no user id) can't call functions
reset request.jwt.claim.sub;
select pg_temp.expect_error($$select public.sell_item('22222222-2222-2222-2222-222222222222', 1, 60)$$, 'Not signed in', 'functions require a user');
reset role;

select pg_temp.expect((select count(*) = 2 from pg_publication_tables where pubname = 'supabase_realtime'), 'realtime publication has both tables');
