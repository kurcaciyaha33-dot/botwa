import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion
} from "@whiskeysockets/baileys";
import pino from "pino";

const BB_KEY = process.env.BB_KEY;
if (!BB_KEY) throw new Error("GitHub Secret BB_KEY belum diatur.");

const FIREBASE = {
  apiKey: "AIzaSyDDxB77qLsX2BD6Y0v7JRppPg0V6-m0vfc",
  databaseURL: "https://wers-app-d921c-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "wers-app-d921c"
};

const BOT_NUMBER = "628877028554".replace(/\D/g, "");
const SESSION_PATH = "Baileys/sessions/main";
const logger = pino({ level: "silent" });

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const encode = value => JSON.stringify(value, (_key, item) => {
  if (item instanceof Uint8Array) {
    return { type: "Buffer", data: Array.from(item) };
  }
  return item;
});
const decode = value => JSON.parse(value, (_key, item) => {
  if (item && item.type === "Buffer" && Array.isArray(item.data)) {
    return Buffer.from(item.data);
  }
  return item;
});

let firebaseIdToken;
let firebaseRefreshToken;
let firebaseTokenExpiry = 0;

async function firebaseRequest(path, options = {}) {
  const url = `${FIREBASE.databaseURL}/${path}.json${firebaseIdToken ? `?auth=${encodeURIComponent(firebaseIdToken)}` : ""}`;
  const response = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) }
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Firebase HTTP ${response.status}: ${body.slice(0, 500)}`);
  return body ? JSON.parse(body) : null;
}

async function getFirebaseToken() {
  if (firebaseIdToken && Date.now() < firebaseTokenExpiry - 60_000) return firebaseIdToken;

  if (firebaseRefreshToken) {
    const refreshResponse = await fetch(
      `https://securetoken.googleapis.com/v1/token?key=${FIREBASE.apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: firebaseRefreshToken
        })
      }
    );
    const refreshed = await refreshResponse.json();
    if (refreshResponse.ok && refreshed.id_token) {
      firebaseIdToken = refreshed.id_token;
      firebaseRefreshToken = refreshed.refresh_token;
      firebaseTokenExpiry = Date.now() + Number(refreshed.expires_in || 3600) * 1000;
      return firebaseIdToken;
    }
    firebaseRefreshToken = undefined;
  }

  // Anonymous Firebase Authentication: no Service Account secret is needed.
  const authResponse = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FIREBASE.apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ returnSecureToken: true })
    }
  );
  const authData = await authResponse.json();
  if (!authResponse.ok || !authData.idToken) {
    throw new Error(`Firebase Anonymous Auth gagal: ${JSON.stringify(authData)}`);
  }
  firebaseIdToken = authData.idToken;
  firebaseRefreshToken = authData.refreshToken;
  firebaseTokenExpiry = Date.now() + Number(authData.expiresIn || 3600) * 1000;
  return firebaseIdToken;
}

async function dbGet(path) {
  await getFirebaseToken();
  return firebaseRequest(path);
}
async function dbPut(path, value) {
  await getFirebaseToken();
  return firebaseRequest(path, { method: "PUT", body: JSON.stringify(value) });
}
async function dbPatch(path, value) {
  await getFirebaseToken();
  return firebaseRequest(path, { method: "PATCH", body: JSON.stringify(value) });
}
async function dbDelete(path) {
  await getFirebaseToken();
  return firebaseRequest(path, { method: "DELETE" });
}

const segment = value => Buffer.from(String(value)).toString("base64url");
const sessionBase = SESSION_PATH;

// Use Baileys' own initializer to ensure the complete auth schema is correct.
const { initAuthCreds, BufferJSON } = await import("@whiskeysockets/baileys");
const serialize = value => JSON.stringify(value, BufferJSON.replacer);
const deserialize = value => JSON.parse(value, BufferJSON.reviver);

async function useFirebaseAuthState() {
  const saved = await dbGet(sessionBase);
  const creds = saved?.creds ? deserialize(saved.creds) : initAuthCreds();

  const keys = {
    async get(type, ids) {
      const result = {};
      const typeData = await dbGet(`${sessionBase}/keys/${segment(type)}`);
      for (const id of ids) {
        const stored = typeData?.[segment(id)];
        if (stored !== undefined && stored !== null) result[id] = deserialize(stored);
      }
      return result;
    },
    async set(data) {
      for (const [type, entries] of Object.entries(data)) {
        const updates = {};
        for (const [id, value] of Object.entries(entries)) {
          updates[segment(id)] = value === null || value === undefined ? null : serialize(value);
        }
        await dbPatch(`${sessionBase}/keys/${segment(type)}`, updates);
      }
    }
  };

  return {
    state: { creds, keys },
    saveCreds: async () => dbPut(`${sessionBase}/creds`, serialize(creds))
  };
}

function getText(message) {
  const m = message?.message;
  return m?.conversation
    ?? m?.extendedTextMessage?.text
    ?? m?.imageMessage?.caption
    ?? m?.videoMessage?.caption
    ?? "";
}

function normalizeUrl(value) {
  let url;
  try { url = new URL(value); }
  catch { throw new Error("URL tidak valid. Contoh: .bypass https://example.com/"); }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("URL harus menggunakan http:// atau https://");
  }
  return url.toString();
}

async function bypass(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  try {
    const response = await fetch("https://baconbypass.online/bypass", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, apikey: BB_KEY }),
      signal: controller.signal
    });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    if (!response.ok) {
      throw new Error(`API HTTP ${response.status}: ${typeof data === "string" ? data : JSON.stringify(data)}`);
    }

    // Only send a URL from the API response, never dump the full JSON payload.
    const found = [];
    const visit = (value, depth = 0) => {
      if (depth > 5 || value == null) return;
      if (typeof value === "string") {
        if (/^https?:\/\/\S+$/i.test(value.trim())) found.push(value.trim());
        return;
      }
      if (Array.isArray(value)) {
        for (const item of value) visit(item, depth + 1);
        return;
      }
      if (typeof value === "object") {
        for (const [key, item] of Object.entries(value)) {
          if (typeof item === "string" && /url|link|result|bypass|short/i.test(key)) visit(item, depth + 1);
          else if (typeof item === "object") visit(item, depth + 1);
        }
      }
    };
    visit(data);
    const unique = [...new Set(found)];
    if (!unique.length) throw new Error("API berhasil merespons, tetapi URL hasil bypass tidak ditemukan di response.");
    return unique.join("\n");
  } finally {
    clearTimeout(timeout);
  }
}

let reconnectTimer;
let stopping = false;

async function startBot() {
  const { state, saveCreds } = await useFirebaseAuthState();
  const { version } = await fetchLatestBaileysVersion();
  let pairingRequested = false;
  let pairingInProgress = false;

  if (!state.creds.registered) {
    if (!/^\\d{8,15}$/.test(BOT_NUMBER)) {
      throw new Error("BOT_NUMBER harus berupa nomor internasional tanpa tanda +, spasi, atau strip.");
    }
    console.log(`Session belum tertaut. Menunggu koneksi WhatsApp sebelum meminta pairing code untuk ${BOT_NUMBER}.`);
  } else {
    console.log("Session WhatsApp ditemukan di Firebase. Mencoba memulihkan koneksi tanpa pairing.");
  }

  const sock = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: false,
    browser: ["WA-Bypass-Bot", "Chrome", "1.0.0"],
    markOnlineOnConnect: false,
    syncFullHistory: false,
    connectTimeoutMs: 60_000,
    defaultQueryTimeoutMs: 60_000
  });

  sock.ev.on("creds.update", () => {
    saveCreds().catch(err => console.error("Gagal menyimpan credentials ke Firebase:", err.message));
  });

  sock.ev.on("connection.update", async update => {
    const { connection, lastDisconnect, qr } = update;

    // Request the pairing code only after Baileys has produced its pairing/QR
    // challenge. Calling it immediately on "connecting" can be too early.
    if (qr && !state.creds.registered && !pairingRequested && !pairingInProgress) {
      pairingInProgress = true;
      try {
        const code = await sock.requestPairingCode(BOT_NUMBER);
        pairingRequested = true;
        console.log("\\n========== WHATSAPP PAIRING ==========");
        console.log(`PAIRING CODE: ${code}`);
        console.log(`Nomor yang diminta: ${BOT_NUMBER}`);
        console.log("Masukkan 8 karakter kode tersebut di WhatsApp > Perangkat tertaut > Tautkan dengan nomor telepon.");
        console.log("Jangan masukkan tanda strip/spasi tambahan dan gunakan kode dari run Actions yang sedang aktif.");
        console.log("======================================\\n");
      } catch (error) {
        console.error("Gagal membuat pairing code:", error?.message || error);
        console.error("Pastikan nomor benar, tunggu sebentar jika terlalu banyak percobaan, lalu jalankan ulang workflow.");
      } finally {
        pairingInProgress = false;
      }
    }

    if (connection === "open") {
      console.log("WhatsApp terhubung; session disimpan di Firebase RTDB.");
    }

    if (connection === "close" && !stopping) {
      const status = lastDisconnect?.error?.output?.statusCode;
      console.log("Koneksi tertutup. Status:", status ?? "unknown");
      if (status === DisconnectReason.loggedOut) {
        console.error("Session logout/revoked. Hapus session Firebase secara manual jika ingin pairing ulang.");
        return;
      }
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => {
        startBot().catch(err => console.error("Reconnect gagal:", err));
      }, 5000);
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const message of messages) {
      if (!message.message) continue;

      // Intentionally do NOT filter key.fromMe: messages sent by the bot's own
      // WhatsApp account (including its own number) can issue .bypass commands.
      const jid = message.key.remoteJid;
      if (!jid || jid === "status@broadcast" || jid.endsWith("@newsletter")) continue;

      const text = getText(message).trim();
      if (!/^\.bypass(?:\s|$)/i.test(text)) continue;

      const argument = text.replace(/^\.bypass/i, "").trim();
      if (!argument) {
        await sock.sendMessage(jid, { text: "Gunakan: .bypass https://link.com/target" }, { quoted: message });
        continue;
      }

      try {
        const url = normalizeUrl(argument);
        await sock.sendMessage(jid, { text: "⏳ Memproses bypass..." }, { quoted: message });
        const resultUrl = await bypass(url);
        await sock.sendMessage(jid, { text: resultUrl }, { quoted: message });
      } catch (error) {
        console.error("Bypass error:", error);
        await sock.sendMessage(jid, {
          text: `❌ ${error.name === "AbortError" ? "Request timeout." : error.message}`
        }, { quoted: message });
      }
    }
  });

  return sock;
}

process.on("SIGTERM", () => { stopping = true; clearTimeout(reconnectTimer); process.exit(0); });
process.on("SIGINT", () => { stopping = true; clearTimeout(reconnectTimer); process.exit(0); });

startBot().catch(error => {
  console.error("Bot gagal dijalankan:", error);
  process.exit(1);
});
