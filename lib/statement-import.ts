type PdfTextItem = { str: string; width: number; transform: number[] };

export type StatementTransaction = {
  date: string;
  description: string;
  amount: number;
  currency: string;
  type: string;
};

const DATE_PATTERN = /(?<!\d)(\d{4}[./-]\d{1,2}[./-]\d{1,2}|\d{1,2}[./-]\d{1,2}[./-](?:\d{2}|\d{4}))(?!\d)/;
const AMOUNT_PATTERN = /(?:\(\s*)?[-+−]?\s*(?:\d{1,3}(?:[ \u00a0\u202f.,]\d{3})+|\d+)[,.]\d{2}\s*(?:\))?(?:\s*(?:EUR|USD|RON|GBP|CHF|CAD|AUD|PLN|CZK|HUF|SEK|NOK|DKK|€|\$|£))?/giu;
const CURRENCY_PATTERN = /\b(EUR|USD|RON|GBP|CHF|CAD|AUD|PLN|CZK|HUF|SEK|NOK|DKK)\b|€/gi;

function parseDate(value: string): string | null {
  const parts = value.split(/[./-]/).map(Number);
  let year: number, month: number, day: number;
  if (parts[0] > 999) [year, month, day] = parts;
  else {
    [day, month, year] = parts;
    if (year < 100) year += year < 70 ? 2000 : 1900;
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
}

function parseAmount(value: string): { amount: number; explicitSign: boolean } | null {
  const explicitSign = /[-+−(]/.test(value);
  const negative = /[-−(]/.test(value);
  let number = value.replace(/[^\d,.]/g, "");
  const comma = number.lastIndexOf(",");
  const dot = number.lastIndexOf(".");
  const decimalAt = Math.max(comma, dot);
  if (decimalAt >= 0) {
    const fractionLength = number.length - decimalAt - 1;
    if (fractionLength === 2) {
      number = number.slice(0, decimalAt).replace(/[,.]/g, "") + "." + number.slice(decimalAt + 1);
    } else {
      number = number.replace(/[,.]/g, "");
    }
  }
  const magnitude = Number(number);
  if (!Number.isFinite(magnitude)) return null;
  return { amount: negative ? -Math.abs(magnitude) : magnitude, explicitSign };
}

function transactionType(amount: number, description: string): string {
  const text = description.toLowerCase();
  if (/\b(refund|reversal|chargeback)\b/.test(text)) return "refund";
  if (/\b(fee|commission|charge)\b/.test(text)) return "fee";
  if (/\b(transfer|internal)\b/.test(text)) return "transfer";
  return amount < 0 ? "expense" : "income";
}

function inferCurrency(text: string): string {
  const counts = new Map<string, number>();
  for (const match of text.matchAll(CURRENCY_PATTERN)) {
    const code = match[1]?.toUpperCase() || "EUR";
    counts.set(code, (counts.get(code) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "EUR";
}

function classifyUnsignedAmount(amount: number, description: string): number {
  const text = description.toLowerCase();
  if (/\b(refund|reversal|chargeback|salary|income|deposit|top[ -]?up|cashback|interest|received|credit)\b/.test(text)) {
    return Math.abs(amount);
  }
  if (/\b(card|payment|purchase|withdrawal|fee|debit|paid|pos|sent|direct debit|transfer out)\b/.test(text)) {
    return -Math.abs(amount);
  }
  return amount;
}

function joinLine(items: PdfTextItem[]): string {
  const ordered = items.filter((item) => item.str.trim()).sort((a, b) => a.transform[4] - b.transform[4]);
  let output = "";
  let previousEnd = 0;
  for (const item of ordered) {
    const x = item.transform[4];
    const gap = x - previousEnd;
    if (output && gap > 14) output += "\t";
    else if (output && gap > 2) output += " ";
    output += item.str;
    previousEnd = x + item.width;
  }
  return output.replace(/[ \t]+/g, " ").trim();
}

export async function extractStatementTransactions(file: File): Promise<StatementTransaction[]> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
  const bytes = new Uint8Array(await file.arrayBuffer());
  const task = pdfjs.getDocument({ data: bytes });
  const pdf = await task.promise;
  if (pdf.numPages > 200) {
    await task.destroy();
    throw new Error("This statement has over 200 pages. Split it into smaller PDFs or import a CSV.");
  }

  const lines: string[] = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    const grouped = new Map<number, PdfTextItem[]>();
    for (const item of content.items) {
      if (!("str" in item) || !("transform" in item) || !item.str.trim()) continue;
      const textItem = item as PdfTextItem;
      const baseline = Math.round(textItem.transform[5] / 2);
      grouped.set(baseline, [...(grouped.get(baseline) || []), textItem]);
    }
    lines.push(...[...grouped.entries()].sort((a, b) => b[0] - a[0]).map(([, items]) => joinLine(items)));
    page.cleanup();
  }
  await task.destroy();

  const fullText = lines.join("\n");
  if (fullText.replace(/\s/g, "").length < 20) {
    throw new Error("This PDF has no selectable text. Scanned PDFs are not supported yet; use a digital statement or CSV.");
  }
  const defaultCurrency = inferCurrency(fullText);
  const transactions: StatementTransaction[] = [];

  for (const line of lines) {
    const dateMatch = DATE_PATTERN.exec(line);
    if (!dateMatch) continue;
    const date = parseDate(dateMatch[1]);
    if (!date) continue;

    const withoutDate = line.replace(dateMatch[0], " ");
    const candidates: Array<{ raw: string; parsed: { amount: number; explicitSign: boolean } }> = [];
    for (const match of withoutDate.matchAll(AMOUNT_PATTERN)) {
      const parsed = parseAmount(match[0]);
      if (parsed && parsed.amount !== 0) candidates.push({ raw: match[0], parsed });
    }
    if (!candidates.length) continue;

    // Statements often include a running balance after the transaction value.
    // Ignore that trailing value when there is more than one monetary column.
    const selected = candidates.length > 1 ? candidates.slice(0, -1).filter((candidate) => candidate.parsed.amount !== 0).at(-1) || candidates[0] : candidates[0];
    const description = withoutDate
      .replace(AMOUNT_PATTERN, " ")
      .replace(CURRENCY_PATTERN, " ")
      .replace(/\b(?:balance|pending|posted|date|description|money out|money in|debit|credit)\b/gi, " ")
      .replace(/[\t|]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (description.length < 2 || /^(?:page \d+|total|opening|closing)$/i.test(description)) continue;

    let amount = selected.parsed.amount;
    if (!selected.parsed.explicitSign) amount = classifyUnsignedAmount(amount, description);
    const currencyMatch = line.match(CURRENCY_PATTERN);
    const currency = currencyMatch?.[1]?.toUpperCase() || (currencyMatch?.[0] === "€" ? "EUR" : defaultCurrency);
    transactions.push({ date, description: description.slice(0, 500), amount, currency, type: transactionType(amount, description) });
  }

  if (!transactions.length) {
    throw new Error("No transaction rows could be read from this PDF layout. Try a digital statement with one transaction per row, or import a CSV.");
  }
  if (transactions.length > 2000) throw new Error("This statement has over 2,000 transaction rows. Split it into smaller PDFs or import a CSV.");
  return transactions;
}
