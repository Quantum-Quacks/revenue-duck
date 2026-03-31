// App Store Server Notifications V2 → Telegram
// Receives Apple's signed notifications and forwards them to Telegram

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// Decode JWS payload (base64url → JSON)
function decodeJWS(jws) {
  const parts = jws.split(".");
  if (parts.length !== 3) return null;
  const payload = Buffer.from(parts[1], "base64url").toString("utf-8");
  return JSON.parse(payload);
}

// Emoji per notification type
const EMOJIS = {
  ONE_TIME_CHARGE: "💰",
  SUBSCRIBED: "🎉",
  DID_RENEW: "🔄",
  DID_FAIL_TO_RENEW: "⚠️",
  EXPIRED: "❌",
  GRACE_PERIOD_EXPIRED: "⏰",
  REFUND: "💸",
  REFUND_DECLINED: "🚫",
  REFUND_REVERSED: "↩️",
  REVOKE: "🔒",
  CONSUMPTION_REQUEST: "📋",
  DID_CHANGE_RENEWAL_PREF: "🔀",
  DID_CHANGE_RENEWAL_STATUS: "🔀",
  OFFER_REDEEMED: "🎁",
  PRICE_INCREASE: "📈",
  RENEWAL_EXTENDED: "📅",
  RENEWAL_EXTENSION: "📅",
  TEST: "🧪",
  EXTERNAL_PURCHASE_TOKEN: "🔗",
};

// Map bundle IDs to friendly app names
const APP_NAMES = {
  "es.quantumquacks.worldmarks": "Worldmarks",
  "es.quantumquacks.kotomaji": "Kotomaji",
  "es.quantumquacks.dgt-a2-testmaster": "DGT A2 TestMaster",
  // Add more apps here
};

// Country code → flag emoji
function countryFlag(code) {
  if (!code || code.length < 2) return "";
  const cc = code.slice(0, 2).toUpperCase();
  return String.fromCodePoint(...[...cc].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

// Format price from milliunits
function formatPrice(price, currency) {
  if (price === undefined || price === null) return null;
  return `${(price / 1000).toFixed(2)} ${currency || ""}`.trim();
}

// Readable notification type
function readableType(type) {
  const map = {
    ONE_TIME_CHARGE: "Nueva compra",
    SUBSCRIBED: "Nueva suscripción",
    DID_RENEW: "Renovación exitosa",
    DID_FAIL_TO_RENEW: "Renovación fallida",
    EXPIRED: "Suscripción expirada",
    GRACE_PERIOD_EXPIRED: "Periodo de gracia expirado",
    REFUND: "Reembolso",
    REFUND_DECLINED: "Reembolso denegado",
    REFUND_REVERSED: "Reembolso revertido",
    REVOKE: "Acceso revocado",
    CONSUMPTION_REQUEST: "Solicitud de consumo",
    DID_CHANGE_RENEWAL_PREF: "Cambio de preferencia",
    DID_CHANGE_RENEWAL_STATUS: "Cambio de estado",
    OFFER_REDEEMED: "Oferta canjeada",
    PRICE_INCREASE: "Aumento de precio",
    RENEWAL_EXTENDED: "Renovación extendida",
    TEST: "Test de Apple",
  };
  return map[type] || type;
}

// Build Telegram message
function buildMessage(notification, transaction) {
  const { notificationType, subtype, data } = notification;
  const emoji = EMOJIS[notificationType] || "📬";
  const appName = APP_NAMES[data?.bundleId] || data?.bundleId || "App desconocida";
  const isSandbox = data?.environment === "Sandbox";

  let lines = [];

  lines.push(`${emoji} <b>${readableType(notificationType)}</b>`);
  if (subtype) lines.push(`↳ <i>${subtype}</i>`);
  lines.push("");
  lines.push(`📱 <b>${appName}</b>`);

  if (transaction.productId) {
    lines.push(`🏷 Producto: <code>${transaction.productId}</code>`);
  }

  const price = formatPrice(transaction.price, transaction.currency);
  if (price) {
    lines.push(`💵 Precio: <b>${price}</b>`);
  }

  if (transaction.storefront) {
    const flag = countryFlag(transaction.storefront);
    lines.push(`${flag} País: ${transaction.storefront}`);
  }

  if (transaction.transactionId) {
    lines.push(`🔖 TX: <code>${transaction.transactionId}</code>`);
  }

  const now = new Date().toLocaleString("es-ES", {
    timeZone: "Europe/Madrid",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  lines.push(`\n🕐 ${now}`);

  if (isSandbox) {
    lines.push(`\n⚠️ <i>SANDBOX</i>`);
  }

  return lines.join("\n");
}

// Send message to Telegram
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

// Vercel serverless handler
export default async function handler(req, res) {
  // Health check
  if (req.method === "GET") {
    return res.status(200).json({ status: "ok", service: "apple-store-notifications" });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { signedPayload } = req.body;

    if (!signedPayload) {
      return res.status(400).json({ error: "Missing signedPayload" });
    }

    // Decode the main notification payload
    const notification = decodeJWS(signedPayload);
    if (!notification) {
      return res.status(400).json({ error: "Invalid JWS" });
    }

    // Decode transaction info if present
    let transaction = {};
    if (notification.data?.signedTransactionInfo) {
      transaction = decodeJWS(notification.data.signedTransactionInfo) || {};
    }

    // Build and send Telegram message
    const message = buildMessage(notification, transaction);
    await sendTelegram(message);

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error("Handler error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
}
