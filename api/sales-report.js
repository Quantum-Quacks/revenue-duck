// App Store Connect Sales Report → Telegram
// Fetches daily sales reports and sends a summary to Telegram via Vercel Cron

import { createSign } from "node:crypto";
import { gunzipSync } from "node:zlib";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN?.trim();
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID?.trim();
const ASC_API_KEY_ID = process.env.ASC_API_KEY_ID?.trim();
const ASC_API_ISSUER_ID = process.env.ASC_API_ISSUER_ID?.trim();
const ASC_PRIVATE_KEY = process.env.ASC_PRIVATE_KEY?.trim();
const ASC_VENDOR_NUMBER = process.env.ASC_VENDOR_NUMBER?.trim();
const CRON_SECRET = process.env.CRON_SECRET?.trim();

// Map bundle IDs to friendly app names
const APP_NAMES = {
  "es.quantumquacks.kaeru": "Kaeru",
  "es.quantumquacks.kotomaji": "Kotomaji",
  "es.quantumquacks.sweepsheep": "SweepSheep",
  "es.quantumquacks.worldmarks": "Worldmarks",
  "es.quantumquacks.dgt-a2-testmaster": "DGT A2 TestMaster",
};

// Product Type Identifiers
const PAID_APP_TYPES = new Set(["1", "1F", "1T"]);
const FREE_APP_TYPES = new Set(["6", "7"]);  // 6=Free app, 7=Redownload
const IAP_TYPES = new Set(["IA1", "IA9", "IAY"]);

// --- JWT generation for App Store Connect API ---

function base64url(buffer) {
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function generateJWT() {
  const now = Math.floor(Date.now() / 1000);

  const header = {
    alg: "ES256",
    kid: ASC_API_KEY_ID,
    typ: "JWT",
  };

  const payload = {
    iss: ASC_API_ISSUER_ID,
    iat: now,
    exp: now + 1200,
    aud: "appstoreconnect-v1",
  };

  const headerB64 = base64url(Buffer.from(JSON.stringify(header)));
  const payloadB64 = base64url(Buffer.from(JSON.stringify(payload)));
  const signingInput = `${headerB64}.${payloadB64}`;

  // Private key is stored as base64 in env var to avoid newline issues
  const privateKey = Buffer.from(ASC_PRIVATE_KEY, "base64").toString("utf-8");

  const sign = createSign("SHA256");
  sign.update(signingInput);
  sign.end();

  const signature = sign.sign(
    { key: privateKey, dsaEncoding: "ieee-p1363" },
    "base64"
  );

  const signatureB64 = signature
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  return `${signingInput}.${signatureB64}`;
}

// --- Fetch sales report from App Store Connect ---

async function fetchSalesReport(reportDate) {
  const jwt = generateJWT();

  const params = new URLSearchParams({
    "filter[reportType]": "SALES",
    "filter[reportSubType]": "SUMMARY",
    "filter[frequency]": "DAILY",
    "filter[reportDate]": reportDate,
    "filter[vendorNumber]": ASC_VENDOR_NUMBER,
  });

  const url = `https://api.appstoreconnect.apple.com/v1/salesReports?${params}`;
  console.log(`Fetching sales report for ${reportDate}...`);

  const res = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: "application/a-gzip",
    },
  });

  if (res.status === 404) {
    console.log("Report not available yet (404)");
    return { notAvailable: true };
  }

  if (!res.ok) {
    const errBody = await res.text();
    console.error(`ASC API error ${res.status}:`, errBody);
    throw new Error(`App Store Connect API error: ${res.status}`);
  }

  // Response is gzip-compressed TSV
  const buffer = Buffer.from(await res.arrayBuffer());
  const decompressed = gunzipSync(buffer);
  const tsv = decompressed.toString("utf-8");

  console.log(`Report fetched, ${tsv.length} chars`);
  return { tsv };
}

// --- Parse TSV sales report ---

function parseSalesReport(tsv) {
  const lines = tsv.trim().split("\n");
  if (lines.length < 2) return [];

  const headers = lines[0].split("\t");
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split("\t");
    if (values.length < headers.length) continue;

    const row = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j].trim()] = values[j]?.trim() || "";
    }
    rows.push(row);
  }

  return rows;
}

// --- Build Telegram message ---

function buildSalesMessage(rows, reportDate) {
  // Format report date as DD/MM/YYYY
  const [year, month, day] = reportDate.split("-");
  const formattedDate = `${day}/${month}/${year}`;

  // Current time in Madrid
  const now = new Date().toLocaleString("es-ES", {
    timeZone: "Europe/Madrid",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  // Filter: only rows with Units > 0 and relevant product types
  const salesRows = rows.filter((r) => {
    const units = parseInt(r["Units"], 10);
    const type = r["Product Type Identifier"];
    return units > 0 && (PAID_APP_TYPES.has(type) || FREE_APP_TYPES.has(type) || IAP_TYPES.has(type));
  });

  if (salesRows.length === 0) {
    return [
      `📊 <b>Resumen de ventas</b> — ${formattedDate}`,
      "",
      "😴 No hubo ventas ayer",
      "",
      `🕐 Generado: ${now}`,
    ].join("\n");
  }

  // Group by category and product
  const paidApps = {}; // key: title, value: { units, proceeds, currency }
  const freeApps = {}; // key: title, value: { units, proceeds, currency }
  const iapProducts = {}; // key: SKU/productId, value: { units, proceeds, currency }

  for (const row of salesRows) {
    const type = row["Product Type Identifier"];
    const units = parseInt(row["Units"], 10) || 0;
    const proceeds = parseFloat(row["Developer Proceeds"]) || 0;
    const currency = row["Currency of Proceeds"] || "EUR";
    const title = row["Title"] || row["SKU"] || "Desconocido";
    const sku = row["SKU"] || title;

    if (PAID_APP_TYPES.has(type)) {
      // Use the app title from the report
      const appTitle = APP_NAMES[sku] || title;
      if (!paidApps[appTitle]) {
        paidApps[appTitle] = { units: 0, proceeds: 0, currency };
      }
      paidApps[appTitle].units += units;
      paidApps[appTitle].proceeds += proceeds * units;
    } else if (FREE_APP_TYPES.has(type)) {
      // Free app downloads/redownloads
      const appTitle = APP_NAMES[sku] || title;
      if (!freeApps[appTitle]) {
        freeApps[appTitle] = { units: 0, proceeds: 0, currency };
      }
      freeApps[appTitle].units += units;
      freeApps[appTitle].proceeds += proceeds * units;
    } else if (IAP_TYPES.has(type)) {
      // Use SKU as identifier for IAP
      const iapName = APP_NAMES[sku] || sku;
      if (!iapProducts[iapName]) {
        iapProducts[iapName] = { units: 0, proceeds: 0, currency };
      }
      iapProducts[iapName].units += units;
      iapProducts[iapName].proceeds += proceeds * units;
    }
  }

  const lines = [`📊 <b>Resumen de ventas</b> — ${formattedDate}`];

  let totalUnits = 0;
  let totalProceeds = 0;
  let totalCurrency = "EUR";

  // Paid apps section
  const paidEntries = Object.entries(paidApps);
  if (paidEntries.length > 0) {
    lines.push("");
    lines.push("🏪 <b>Apps de pago:</b>");
    for (const [name, data] of paidEntries) {
      const unitLabel = data.units === 1 ? "ud" : "uds";
      lines.push(
        `  • ${name} — ${data.units} ${unitLabel} — ${data.proceeds.toFixed(2)} ${data.currency}`
      );
      totalUnits += data.units;
      totalProceeds += data.proceeds;
      totalCurrency = data.currency;
    }
  }

  // Free apps section
  const freeEntries = Object.entries(freeApps);
  if (freeEntries.length > 0) {
    lines.push("");
    lines.push("📥 <b>Apps gratuitas:</b>");
    for (const [name, data] of freeEntries) {
      const unitLabel = data.units === 1 ? "descarga" : "descargas";
      lines.push(`  • ${name} — ${data.units} ${unitLabel}`);
      totalUnits += data.units;
    }
  }

  // IAP section
  const iapEntries = Object.entries(iapProducts);
  if (iapEntries.length > 0) {
    lines.push("");
    lines.push("🛒 <b>Compras In-App:</b>");
    for (const [name, data] of iapEntries) {
      const unitLabel = data.units === 1 ? "ud" : "uds";
      lines.push(
        `  • ${name} — ${data.units} ${unitLabel} — ${data.proceeds.toFixed(2)} ${data.currency}`
      );
      totalUnits += data.units;
      totalProceeds += data.proceeds;
      totalCurrency = data.currency;
    }
  }

  // Total
  const totalUnitLabel = totalUnits === 1 ? "venta" : "ventas";
  lines.push("");
  lines.push(
    `💰 <b>Total:</b> ${totalUnits} ${totalUnitLabel} — ${totalProceeds.toFixed(2)} ${totalCurrency}`
  );

  lines.push("");
  lines.push(`🕐 Generado: ${now}`);

  return lines.join("\n");
}

// --- Send message to Telegram ---

async function sendTelegram(text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error("Telegram error:", err);
    throw new Error(`Telegram API error: ${res.status}`);
  }
}

// --- Get yesterday's date in YYYY-MM-DD ---

function getYesterdayDate() {
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const y = yesterday.getUTCFullYear();
  const m = String(yesterday.getUTCMonth() + 1).padStart(2, "0");
  const d = String(yesterday.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// --- Vercel serverless handler ---

export default async function handler(req, res) {
  // Health check
  if (req.method === "GET" && !req.headers.authorization) {
    return res
      .status(200)
      .json({ status: "ok", service: "sales-report" });
  }

  // Security: verify CRON_SECRET if configured
  if (CRON_SECRET) {
    const authHeader = req.headers.authorization;
    if (authHeader !== `Bearer ${CRON_SECRET}`) {
      console.error("Unauthorized request — invalid CRON_SECRET");
      return res.status(401).json({ error: "Unauthorized" });
    }
  }

  try {
    // Validate required env vars
    const missing = [];
    if (!ASC_API_KEY_ID) missing.push("ASC_API_KEY_ID");
    if (!ASC_API_ISSUER_ID) missing.push("ASC_API_ISSUER_ID");
    if (!ASC_PRIVATE_KEY) missing.push("ASC_PRIVATE_KEY");
    if (!ASC_VENDOR_NUMBER) missing.push("ASC_VENDOR_NUMBER");
    if (!TELEGRAM_BOT_TOKEN) missing.push("TELEGRAM_BOT_TOKEN");
    if (!TELEGRAM_CHAT_ID) missing.push("TELEGRAM_CHAT_ID");

    if (missing.length > 0) {
      console.error("Missing env vars:", missing.join(", "));
      return res
        .status(500)
        .json({ error: `Missing env vars: ${missing.join(", ")}` });
    }

    const reportDate = getYesterdayDate();
    console.log(`Processing sales report for ${reportDate}`);

    const result = await fetchSalesReport(reportDate);

    if (result.notAvailable) {
      // Report not ready yet — notify via Telegram, don't treat as error
      const [year, month, day] = reportDate.split("-");
      const formattedDate = `${day}/${month}/${year}`;

      const now = new Date().toLocaleString("es-ES", {
        timeZone: "Europe/Madrid",
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });

      const message = [
        `📊 <b>Resumen de ventas</b> — ${formattedDate}`,
        "",
        "⏳ El informe de ventas aún no está disponible.",
        "Apple suele publicarlo más tarde.",
        "",
        `🕐 ${now}`,
      ].join("\n");

      await sendTelegram(message);
      console.log("Sent 'not available' notification to Telegram");
      return res.status(200).json({ ok: true, reportAvailable: false });
    }

    // Parse and build message
    const rows = parseSalesReport(result.tsv);
    console.log(`Parsed ${rows.length} rows from report`);

    const message = buildSalesMessage(rows, reportDate);
    await sendTelegram(message);
    console.log("Sales report sent to Telegram");

    return res.status(200).json({ ok: true, rows: rows.length });
  } catch (error) {
    console.error("Sales report error:", error);
    return res
      .status(500)
      .json({ error: "Internal server error", message: error.message });
  }
}
