import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const ALLOWED_TYPES = new Set(["expense", "income", "transfer", "refund", "fee", "other"]);

function json(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "POST required" }, 405);

  try {
    const authorization = req.headers.get("Authorization");
    if (!authorization?.startsWith("Bearer ")) throw new Error("Sign in is required.");
    const token = authorization.slice(7);
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      {
        global: { headers: { Authorization: `Bearer ${token}` } },
        auth: { autoRefreshToken: false, persistSession: false },
      },
    );
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) return json({ ok: false, error: "A valid sign-in is required." }, 401);

    const body = await req.json();
    const fileName = typeof body.file_name === "string" ? body.file_name.slice(0, 255) : "bank-statement.pdf";
    const transactions = Array.isArray(body.transactions) ? body.transactions : [];
    if (!transactions.length) throw new Error("No transaction rows were extracted. Use a digital statement PDF or import a CSV.");
    if (transactions.length > 2000) throw new Error("This statement has too many rows. Split it into smaller PDFs.");

    const validRows: Array<Record<string, unknown>> = [];
    const occurrences = new Map<string, number>();
    let invalidRows = 0;
    for (const item of transactions) {
      const amount = Number(item?.amount);
      const description = typeof item?.description === "string" ? item.description.trim().slice(0, 500) : "";
      const currency = typeof item?.currency === "string" ? item.currency.trim().toUpperCase() : "";
      const rawDate = typeof item?.date === "string" ? item.date : "";
      let date: string | null = null;
      if (/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) {
        const parsedDate = new Date(rawDate + "T12:00:00Z");
        if (!Number.isNaN(parsedDate.getTime()) && parsedDate.toISOString().slice(0, 10) === rawDate) date = rawDate;
      }
      if (!description || !Number.isFinite(amount) || !/^[A-Z]{3}$/.test(currency)) {
        invalidRows++;
        continue;
      }
      const proposedType = typeof item?.type === "string" ? item.type.toLowerCase() : "";
      const transactionType = ALLOWED_TYPES.has(proposedType) ? proposedType : amount < 0 ? "expense" : "income";
      const fingerprint = [date || "", description.toLowerCase(), amount.toFixed(2), currency].join("|");
      const occurrence = occurrences.get(fingerprint) || 0;
      occurrences.set(fingerprint, occurrence + 1);
      const importKey = await sha256(`${user.id}|${fingerprint}|${occurrence}`);
      const transactionDate = date ? `${date}T12:00:00.000Z` : null;
      validRows.push({
        user_id: user.id,
        import_key: importKey,
        transaction_date: transactionDate,
        completed_date: transactionDate,
        merchant_raw: description,
        description,
        amount,
        currency,
        transaction_type: transactionType,
        source: "bank_statement_pdf",
      });
    }
    if (!validRows.length) throw new Error("No usable transaction rows were found. Check that this PDF contains a bank statement.");

    const { data: batch, error: batchError } = await supabase
      .from("import_batches")
      .insert({ user_id: user.id, source: "bank_statement_pdf", file_name: fileName, row_count: validRows.length })
      .select("id")
      .single();
    if (batchError) throw batchError;

    let imported = 0;
    let duplicates = 0;
    for (let i = 0; i < validRows.length; i += 100) {
      const chunk = validRows.slice(i, i + 100);
      const { data, error } = await supabase
        .from("transactions")
        .upsert(chunk, { onConflict: "user_id,import_key", ignoreDuplicates: true })
        .select("id");
      if (error) throw error;
      imported += data?.length || 0;
      duplicates += chunk.length - (data?.length || 0);
    }

    const { error: updateError } = await supabase
      .from("import_batches")
      .update({ imported_count: imported, skipped_count: duplicates + invalidRows })
      .eq("id", batch.id)
      .eq("user_id", user.id);
    if (updateError) throw updateError;

    return json({
      ok: true,
      batch_id: batch.id,
      rows_received: transactions.length,
      rows_processed: imported,
      rows_skipped: duplicates + invalidRows,
    });
  } catch (error) {
    return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 400);
  }
});
