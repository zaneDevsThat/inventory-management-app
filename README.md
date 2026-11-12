# Inventory Manager

A small inventory and sales tracker. It's hosted on **GitHub Pages**, and the data lives in **Supabase** (Postgres + login).

- Multiple businesses, each with its own inventory and sales: add, rename, delete (typed confirmation), switch from the top bar
- Add, edit and delete items: name, date acquired, quantity, acquired amount (USD), selling price (PHP)
- Summary cards filterable by year, then month (mm/yyyy)
- Group inventory (by date acquired) and sales (by date sold) weekly (Mon–Sun), monthly or yearly; yearly groups expand into months, all groups collapsible, with subtotals
- In-stock status is set from quantity; out-of-stock items are dimmed
- Live USD → PHP conversion ([open.er-api.com](https://www.exchangerate-api.com/docs/free), updated daily)
- Record sales with an optional comment (e.g. who it was sold to): stock goes down, and each sale is saved with its price, cost and exchange rate
- Sales history with markup per unit (selling price − acquired amount in PHP); void a sale to return stock
- Day/night mode, live updates across users, invite-only sign-in

## Architecture

| Piece | Where |
|---|---|
| Frontend (static HTML/CSS/JS) | `public/` → GitHub Pages, deployed by `.github/workflows/deploy.yml` on every push to `main` |
| Database, auth, access rules | Supabase; schema in `supabase/schema.sql` |

The Supabase URL and publishable/anon key in `public/config.js` are **meant to be public**. Data is protected by sign-in plus row-level security: anonymous visitors can't read or change anything, and sales can only be created or voided through the `sell_item` / `void_sale` database functions, which keep stock and sales consistent.

## One-time Supabase setup

1. Create a free project at <https://supabase.com> (pick a region near you, e.g. Singapore).
2. **SQL Editor → New query**: paste all of `supabase/schema.sql` and click **Run**.
3. **Authentication → Sign In / Providers**: turn **off** “Allow new users to sign up”. Keep the Email provider enabled.
4. **Authentication → Users → Add user → Create new user**: enter the email and a password for each person, and tick **Auto Confirm User**. Send each person their password privately. They can change it from the account menu after signing in.
5. **Project Settings → API Keys** (and **Data API** for the URL): copy the **Project URL** and the **publishable** key (or legacy **anon** key) into `public/config.js`, then commit and push.

To remove someone's access, delete their user under **Authentication → Users**.

### Updating the database

`supabase/schema.sql` is safe to re-run and upgrades an existing database in place. After pulling a change to it, paste the whole file into the SQL Editor and run it **before** the new frontend deploys.

## Local development

```bash
npm start          # http://localhost:3000 (uses the Supabase project in config.js)
npm test           # unit tests for public/lib.js
npm run test:db    # tests supabase/schema.sql against a throwaway Postgres (needs Docker)
```
