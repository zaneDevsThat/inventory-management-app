-- Inventory Manager — Supabase schema
-- Run once in Supabase Dashboard → SQL Editor → New query → paste → Run.
-- Safe to re-run: objects are created idempotently where possible.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
-- Each business has its own inventory and sales.
create table if not exists public.businesses (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (length(btrim(name)) between 1 and 80),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- Business names are unique, ignoring case and surrounding spaces.
create unique index if not exists businesses_name_key on public.businesses (lower(btrim(name)));

create table if not exists public.items (
  id                  uuid primary key default gen_random_uuid(),
  -- Deleting a business deletes its inventory.
  business_id         uuid not null references public.businesses (id) on delete cascade,
  name                text not null check (length(btrim(name)) between 1 and 100),
  quantity            integer not null check (quantity >= 0),
  -- Derived, so it can never disagree with quantity.
  in_stock            boolean generated always as (quantity > 0) stored,
  acquired_amount_usd numeric(12, 2) not null check (acquired_amount_usd >= 0),
  selling_price_php   numeric(12, 2) not null check (selling_price_php >= 0),
  acquired_on         date not null default current_date check (acquired_on >= date '2000-01-01'),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create table if not exists public.sales (
  id                  uuid primary key default gen_random_uuid(),
  -- Deleting a business deletes its sales history.
  business_id         uuid not null references public.businesses (id) on delete cascade,
  -- Kept when the item is deleted, so history and totals survive.
  item_id             uuid references public.items (id) on delete set null,
  item_name           text not null,
  quantity            integer not null check (quantity > 0),
  unit_price_php      numeric(12, 2) not null,
  total_php           numeric(14, 2) not null,
  -- Snapshots at sale time so the markup never changes afterwards.
  acquired_amount_usd numeric(12, 2) not null,
  usd_to_php          numeric(14, 6),          -- null if the rate was unavailable
  markup_php          numeric(12, 2),          -- per unit: selling price - acquired amount in PHP
  sold_at             timestamptz not null default now(),
  sold_by             uuid references auth.users (id) on delete set null,
  -- Free-text note, e.g. who the item was sold to.
  comment             text check (comment is null or length(comment) <= 500)
);

-- Upgrade for databases created before sales.comment existed.
alter table public.sales add column if not exists comment text;
do $$
begin
  if not exists (select 1 from pg_constraint
                 where conrelid = 'public.sales'::regclass and conname = 'sales_comment_check') then
    alter table public.sales
      add constraint sales_comment_check check (comment is null or length(comment) <= 500);
  end if;
end;
$$;

-- Upgrade for databases created before acquired_on existed:
-- existing items get the date they were added as their acquisition date.
do $$
begin
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'items' and column_name = 'acquired_on') then
    alter table public.items add column acquired_on date;
    update public.items set acquired_on = (created_at at time zone 'Asia/Manila')::date;
    alter table public.items
      alter column acquired_on set default current_date,
      alter column acquired_on set not null,
      add constraint items_acquired_on_check check (acquired_on >= date '2000-01-01');
  end if;
end;
$$;

-- Upgrade for databases created before businesses existed: existing items and
-- sales are moved into a business called "My business" (rename it in the app).
do $$
declare
  v_default uuid;
begin
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'items' and column_name = 'business_id') then
    alter table public.items
      add column business_id uuid references public.businesses (id) on delete cascade;
  end if;
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'sales' and column_name = 'business_id') then
    alter table public.sales
      add column business_id uuid references public.businesses (id) on delete cascade;
  end if;

  if exists (select 1 from public.items where business_id is null)
     or exists (select 1 from public.sales where business_id is null) then
    select id into v_default from public.businesses order by created_at limit 1;
    if v_default is null then
      insert into public.businesses (name) values ('My business') returning id into v_default;
    end if;
    update public.items set business_id = v_default where business_id is null;
    -- A sale belongs to its item's business; sales of deleted items go to the default.
    update public.sales s
       set business_id = coalesce((select i.business_id from public.items i where i.id = s.item_id), v_default)
     where s.business_id is null;
  end if;

  alter table public.items alter column business_id set not null;
  alter table public.sales alter column business_id set not null;
end;
$$;

create index if not exists items_business_id_idx on public.items (business_id);
create index if not exists sales_business_sold_at_idx on public.sales (business_id, sold_at desc);
create index if not exists sales_item_id_idx on public.sales (item_id);
create index if not exists items_acquired_on_idx on public.items (acquired_on desc);
create index if not exists sales_sold_at_idx on public.sales (sold_at desc);

-- Keep items.updated_at current.
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists businesses_touch_updated_at on public.businesses;
create trigger businesses_touch_updated_at
  before update on public.businesses
  for each row execute function public.touch_updated_at();

drop trigger if exists items_touch_updated_at on public.items;
create trigger items_touch_updated_at
  before update on public.items
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Access control: only signed-in users. Anonymous visitors get nothing.
-- (Public sign-ups must also be disabled in Authentication settings, so the
-- only signed-in users are the ones you create.)
-- ---------------------------------------------------------------------------
alter table public.businesses enable row level security;
alter table public.items enable row level security;
alter table public.sales enable row level security;

revoke all on public.businesses, public.items, public.sales from anon, authenticated;
grant select, insert, update, delete on public.businesses to authenticated;
grant select, insert, update, delete on public.items to authenticated;
-- Sales can only be created/removed through sell_item / void_sale below,
-- so stock and sales history can't drift apart.
grant select on public.sales to authenticated;

drop policy if exists "signed-in users manage businesses" on public.businesses;
create policy "signed-in users manage businesses" on public.businesses
  for all to authenticated using (true) with check (true);

drop policy if exists "signed-in users manage items" on public.items;
create policy "signed-in users manage items" on public.items
  for all to authenticated using (true) with check (true);

drop policy if exists "signed-in users read sales" on public.sales;
create policy "signed-in users read sales" on public.sales
  for select to authenticated using (true);

-- ---------------------------------------------------------------------------
-- Atomic operations
-- ---------------------------------------------------------------------------

-- Record a sale: locks the item row, checks stock, decrements it and inserts
-- the sale (with price, cost and rate snapshots) in one transaction.
-- Replaces the earlier 3-argument version (p_comment is optional, so old callers still work).
drop function if exists public.sell_item(uuid, integer, numeric);
create or replace function public.sell_item(
  p_item_id uuid, p_quantity integer, p_usd_to_php numeric, p_comment text default null
)
returns public.sales
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item public.items;
  v_sale public.sales;
begin
  if auth.uid() is null then
    raise exception 'Not signed in';
  end if;
  if p_quantity is null or p_quantity < 1 then
    raise exception 'Quantity sold must be a whole number of at least 1';
  end if;
  if p_usd_to_php is not null and p_usd_to_php <= 0 then
    raise exception 'Invalid exchange rate';
  end if;
  -- Blank comments are stored as null.
  p_comment := nullif(btrim(p_comment), '');
  if length(p_comment) > 500 then
    raise exception 'Comment must be 500 characters or fewer';
  end if;

  select * into v_item from public.items where id = p_item_id for update;
  if not found then
    raise exception 'Item not found';
  end if;
  if p_quantity > v_item.quantity then
    raise exception 'Only % in stock', v_item.quantity;
  end if;

  update public.items set quantity = quantity - p_quantity where id = p_item_id;

  insert into public.sales (
    business_id, item_id, item_name, quantity, unit_price_php, total_php,
    acquired_amount_usd, usd_to_php, markup_php, sold_by, comment
  ) values (
    v_item.business_id, v_item.id, v_item.name, p_quantity, v_item.selling_price_php,
    round(p_quantity * v_item.selling_price_php, 2),
    v_item.acquired_amount_usd, p_usd_to_php,
    case when p_usd_to_php is null then null
         else round(v_item.selling_price_php - v_item.acquired_amount_usd * p_usd_to_php, 2) end,
    auth.uid(),
    p_comment
  )
  returning * into v_sale;

  return v_sale;
end;
$$;

-- Void a sale: removes it and returns the units to stock (if the item still exists).
create or replace function public.void_sale(p_sale_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sale public.sales;
begin
  if auth.uid() is null then
    raise exception 'Not signed in';
  end if;

  delete from public.sales where id = p_sale_id returning * into v_sale;
  if not found then
    raise exception 'Sale not found';
  end if;

  if v_sale.item_id is not null then
    update public.items set quantity = quantity + v_sale.quantity where id = v_sale.item_id;
  end if;
end;
$$;

revoke all on function public.sell_item(uuid, integer, numeric, text) from public, anon;
revoke all on function public.void_sale(uuid) from public, anon;
grant execute on function public.sell_item(uuid, integer, numeric, text) to authenticated;
grant execute on function public.void_sale(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Live updates: everyone with the app open sees changes immediately.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (select 1 from pg_publication_tables
                   where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'businesses') then
      alter publication supabase_realtime add table public.businesses;
    end if;
    if not exists (select 1 from pg_publication_tables
                   where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'items') then
      alter publication supabase_realtime add table public.items;
    end if;
    if not exists (select 1 from pg_publication_tables
                   where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'sales') then
      alter publication supabase_realtime add table public.sales;
    end if;
  end if;
end;
$$;
