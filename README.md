# Ledger — Personal Finance Agent

A Next.js dashboard for the existing Supabase project, with signed-in transaction views, AI categorization, and receipt analysis.

## Vercel

Add these variables to the Vercel project for Preview and Production:

- `NEXT_PUBLIC_SUPABASE_URL` = `https://wqizcjgsyfhsvdtbvkrk.supabase.co`
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` = the project's `sb_publishable_...` key (or its legacy anon key)

Redeploy after setting them. The publishable key is intended for browser use; never set a service-role or OpenAI key as a `NEXT_PUBLIC_` variable. Supabase Auth and row-level security must restrict the finance tables to signed-in users. Categorization and receipt analysis call the existing JWT-protected Edge Functions; keep their service-role and OpenAI keys in Supabase secrets.

The Supabase project was reported as inactive during setup, and the database table lookup timed out. Resume the project and confirm its RLS policies if the dashboard cannot load records.

## Local development

Copy `.env.example` to `.env.local`, set the publishable key, install dependencies, and run `npm run dev`.
