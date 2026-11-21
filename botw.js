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
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  const body = await response.text();

  if (!response.ok) {
    throw new Error(`Firebase HTTP ${response.status}: ${body.slice(0, 500)}`);
  }

  return body ? JSON.parse(body) : null;
}

async function getFirebaseToken() {
  if (firebaseIdToken && Date.now() < firebaseTokenExpiry - 60_000) {
    return firebaseIdToken;
  }

  if (firebaseRefreshToken) {
    const refreshResponse = await fetch(
      `https://securetoken.googleapis.com/v1/token?key=${FIREBASE.apiKey}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded"
        },
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
      firebaseTokenExpiry =
        Date.now() + Number(refreshed.expires_in || 3600) * 1000;

      return firebaseIdToken;
    }

    firebaseRefreshToken = undefined;
  }

  // Firebase Anonymous Authentication.
  const authResponse = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FIREBASE.apiKey}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        returnSecureToken: true
      })
    }
  );

  const authData = await authResponse.json();

  if (!authResponse.ok || !authData.idToken) {
    throw new Error(
      `Firebase Anonymous Auth gagal: ${JSON.stringify(authData)}`
    );
  }

  firebaseIdToken = authData.idToken;
  firebaseRefreshToken = authData.refreshToken;
  firebaseTokenExpiry =
    Date.now() + Number(authData.expiresIn || 3600) * 1000;

  return firebaseIdToken;
}

async function dbGet(path) {
  await getFirebaseToken();
  return firebaseRequest(path);
}

async function dbPut(path, value) {
  await getFirebaseToken();

  return firebaseRequest(path, {
    method: "PUT",
    body: JSON.stringify(value)
  });
}

async function dbPatch(path, value) {
  await getFirebaseToken();

  return firebaseRequest(path, {
    method: "PATCH",
    body: JSON.stringify(value)
  });
}

async function dbDelete(path) {
  await getFirebaseToken();

  return firebaseRequest(path, {
    method: "DELETE"
  });
}

const segment = value =>
  Buffer.from(String(value)).toString("base64url");

const sessionBase = SESSION_PATH;

const { initAuthCreds, BufferJSON } =
  await import("@whiskeysockets/baileys");

const serialize = value =>
  JSON.stringify(value, BufferJSON.replacer);

const deserialize = value =>
  JSON.parse(value, BufferJSON.reviver);

async function useFirebaseAuthState() {
  const saved = await dbGet(sessionBase);

  const hasSavedCreds = Boolean(
    saved &&
    typeof saved.creds === "string" &&
    saved.creds.length > 0
  );

  const creds = hasSavedCreds
    ? deserialize(saved.creds)
    : initAuthCreds();

  console.log(`[Firebase] Session path: ${sessionBase}`);
  console.log(
    `[Firebase] RTDB node exists: ${saved !== null && saved !== undefined}`
  );
  console.log(`[Firebase] Credentials exist: ${hasSavedCreds}`);
  console.log(
    `[Firebase] WhatsApp registered: ${Boolean(creds.registered)}`
  );

  if (!hasSavedCreds) {
    console.log("[Firebase] Belum ada session. Pairing baru diperlukan.");
  }

  // Session hanya disimpan setelah WhatsApp benar-benar terbuka.
  let sessionReady = false;

  const keyCache = new Map();
  const dirtyTypes = new Set();

  let persistQueue = Promise.resolve();

  async function loadType(type) {
    if (keyCache.has(type)) {
      return keyCache.get(type);
    }

    const stored = await dbGet(
      `${sessionBase}/keys/${segment(type)}`
    );

    const entries = new Map();

    for (const [id, value] of Object.entries(stored || {})) {
      if (value !== null && value !== undefined) {
        entries.set(id, deserialize(value));
      }
    }

    keyCache.set(type, entries);

    return entries;
  }

  function queuePersist(task) {
    persistQueue = persistQueue.then(task);
    return persistQueue;
  }

  async function persistType(type) {
    const entries = keyCache.get(type);

    if (!entries || !dirtyTypes.has(type)) {
      return;
    }

    const updates = {};

    for (const [id, value] of entries) {
      updates[segment(id)] = serialize(value);
    }

    const deleted = entries.deleted || [];

    for (const id of deleted) {
      updates[segment(id)] = null;
    }

    await dbPatch(
      `${sessionBase}/keys/${segment(type)}`,
      updates
    );

    entries.deleted = [];
    dirtyTypes.delete(type);
  }

  async function persistAll() {
    if (!sessionReady) {
      return;
    }

    await queuePersist(async () => {
      await dbPut(
        `${sessionBase}/creds`,
        serialize(creds)
      );

      for (const type of [...dirtyTypes]) {
        await persistType(type);
      }

      console.log(
        `[Firebase] Session berhasil disimpan ke ${sessionBase}`
      );
    });
  }

  const keys = {
    async get(type, ids) {
      const entries = await loadType(type);
      const result = {};

      for (const id of ids) {
        if (entries.has(id)) {
          result[id] = entries.get(id);
        }
      }

      return result;
    },

    async set(data) {
      for (const [type, values] of Object.entries(data)) {
        const entries = await loadType(type);

        if (!entries.deleted) {
          entries.deleted = [];
        }

        for (const [id, value] of Object.entries(values)) {
          if (value === null || value === undefined) {
            entries.delete(id);

            if (!entries.deleted.includes(id)) {
              entries.deleted.push(id);
            }
          } else {
            entries.set(id, value);

            entries.deleted =
              entries.deleted.filter(item => item !== id);
          }
        }

        dirtyTypes.add(type);
      }

      if (sessionReady) {
        await persistAll();
      }
    }
  };

  return {
    state: { creds, keys },

    enablePersistence: async () => {
      sessionReady = true;
      await persistAll();
    },

    saveCreds: async () => {
      if (sessionReady) {
        await persistAll();
      }
    }
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

  try {
    url = new URL(value);
  } catch {
    throw new Error(
      "URL tidak valid. Contoh: .bypass https://example.com/"
    );
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error(
      "URL harus menggunakan http:// atau https://"
    );
  }

  return url.toString();
}

async function bypass(url) {
  const controller = new AbortController();

  const timeout = setTimeout(
    () => controller.abort(),
    60_000
  );

  try {
    const response = await fetch(
      "https://baconbypass.online/bypass",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          url,
          apikey: BB_KEY
        }),
        signal: controller.signal
      }
    );

    const text = await response.text();

    let data;

    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }

    if (!response.ok) {
      throw new Error(
        `API HTTP ${response.status}: ${
          typeof data === "string"
            ? data
            : JSON.stringify(data)
        }`
      );
    }

    // Hanya kirim URL hasil API.
    const found = [];

    const visit = (value, depth = 0) => {
      if (depth > 5 || value == null) {
        return;
      }

      if (typeof value === "string") {
        if (/^https?:\/\/\S+$/i.test(value.trim())) {
          found.push(value.trim());
        }

        return;
      }

      if (Array.isArray(value)) {
        for (const item of value) {
          visit(item, depth + 1);
        }

        return;
      }

      if (typeof value === "object") {
        for (const [key, item] of Object.entries(value)) {
          if (
            typeof item === "string" &&
            /url|link|result|bypass|short/i.test(key)
          ) {
            visit(item, depth + 1);
          } else if (typeof item === "object") {
            visit(item, depth + 1);
          }
        }
      }
    };

    visit(data);

    const unique = [...new Set(found)];

    if (!unique.length) {
      throw new Error(
        "API berhasil merespons, tetapi URL hasil bypass tidak ditemukan di response."
      );
    }

    return unique.join("\n");

  } finally {
    clearTimeout(timeout);
  }
}

let reconnectTimer;
let stopping = false;

const PAIRING_WAIT_MS = 2 * 60 * 1000;

async function startBot() {
  if (stopping) {
    return;
  }

  const auth = await useFirebaseAuthState();

  const {
    state,
    enablePersistence,
    saveCreds
  } = auth;

  const { version } = await fetchLatestBaileysVersion();

  if (
    !state.creds.registered &&
    !/^\d{8,15}$/.test(BOT_NUMBER)
  ) {
    throw new Error(
      "BOT_NUMBER harus berupa nomor internasional tanpa tanda +, spasi, atau strip."
    );
  }

  let pairingTimer;
  let pairingRequested = false;
  let pairingInProgress = false;
  let sessionOpened = false;
  let restartingForPairing = false;

  if (state.creds.registered) {
    console.log(
      "[WhatsApp] Session ditemukan. Mencoba memulihkan koneksi..."
    );
  } else {
    console.log(
      `[WhatsApp] Menunggu pairing untuk nomor ${BOT_NUMBER}.`
    );
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

  const restartPairing = async () => {
    if (
      stopping ||
      sessionOpened ||
      restartingForPairing
    ) {
      return;
    }

    restartingForPairing = true;

    clearTimeout(pairingTimer);

    console.log(
      "[Pairing] 2 menit berlalu. Membuat pairing code baru..."
    );

    try {
      sock.end(undefined);
    } catch {}

    clearTimeout(reconnectTimer);

    reconnectTimer = setTimeout(() => {
      startBot().catch(err =>
        console.error("Pairing restart gagal:", err)
      );
    }, 1500);
  };

  sock.ev.on("creds.update", () => {
    // Tidak menyimpan credential sebelum koneksi terbuka.
    if (sessionOpened) {
      saveCreds().catch(err => {
        console.error(
          "[Firebase] Gagal menyimpan credentials:",
          err.message
        );
      });
    }
  });

  sock.ev.on("connection.update", async update => {
    const {
      connection,
      lastDisconnect
    } = update;

    // Timer pairing dimulai saat koneksi pertama kali dimulai.
    if (
      connection === "connecting" &&
      !state.creds.registered &&
      !pairingTimer
    ) {
      pairingTimer = setTimeout(
        restartPairing,
        PAIRING_WAIT_MS
      );
    }

    // Meminta pairing code.
    if (
      connection === "connecting" &&
      !state.creds.registered &&
      !pairingRequested &&
      !pairingInProgress
    ) {
      pairingInProgress = true;

      try {
        await sleep(1500);

        if (
          stopping ||
          sessionOpened ||
          restartingForPairing
        ) {
          return;
        }

        const code = await sock.requestPairingCode(
          BOT_NUMBER
        );

        pairingRequested = true;

        console.log(
          "\n========== WHATSAPP PAIRING =========="
        );

        console.log(`PAIRING CODE: ${code}`);
        console.log(`Nomor: ${BOT_NUMBER}`);

        console.log(
          "Masukkan kode di WhatsApp > Perangkat tertaut > Tautkan dengan nomor telepon."
        );

        console.log(
          "Bot akan menunggu 2 menit tanpa menyimpulkan status pairing."
        );

        console.log(
          "======================================\n"
        );

      } catch (error) {
        console.error(
          "[Pairing] Tidak dapat meminta code saat ini:",
          error?.message || error
        );

        console.log(
          "[Pairing] Tetap menunggu hingga batas 2 menit sebelum mencoba code baru."
        );

      } finally {
        pairingInProgress = false;
      }
    }

    // Koneksi benar-benar terbuka.
    if (connection === "open") {
      sessionOpened = true;

      clearTimeout(pairingTimer);

      console.log(
        "[WhatsApp] Koneksi terbuka. Menyimpan session ke Firebase RTDB..."
      );

      try {
        await enablePersistence();

        console.log(
          "[WhatsApp] Pairing/koneksi selesai. Session sudah tersimpan."
        );

      } catch (error) {
        console.error(
          "[Firebase] Gagal menyimpan session setelah koneksi terbuka:",
          error.message
        );
      }
    }

    // Koneksi tertutup.
    if (connection === "close" && !stopping) {
      const status =
        lastDisconnect?.error?.output?.statusCode;

      // Saat pairing pertama, jangan langsung menyimpulkan gagal.
      if (
        !state.creds.registered &&
        !sessionOpened
      ) {
        console.log(
          "[Pairing] Koneksi berubah; tetap menunggu batas waktu pairing."
        );

        return;
      }

      console.log(
        "[WhatsApp] Koneksi tertutup. Status:",
        status ?? "unknown"
      );

      if (status === DisconnectReason.loggedOut) {
        console.error(
          "[WhatsApp] Session logout/revoked. Hapus session Firebase jika ingin pairing ulang."
        );

        return;
      }

      clearTimeout(reconnectTimer);

      reconnectTimer = setTimeout(() => {
        startBot().catch(err =>
          console.error("Reconnect gagal:", err)
        );
      }, 5000);
    }
  });

  sock.ev.on(
    "messages.upsert",
    async ({ messages, type }) => {
      if (type !== "notify") {
        return;
      }

      for (const message of messages) {
        if (!message.message) {
          continue;
        }

        // Mendukung command dari nomor bot sendiri.
        const jid = message.key.remoteJid;

        if (
          !jid ||
          jid === "status@broadcast" ||
          jid.endsWith("@newsletter")
        ) {
          continue;
        }

        const text = getText(message).trim();

        if (!/^\.bypass(?:\s|$)/i.test(text)) {
          continue;
        }

        const argument = text
          .replace(/^\.bypass/i, "")
          .trim();

        if (!argument) {
          await sock.sendMessage(
            jid,
            {
              text: "Gunakan: .bypass https://link.com/target"
            },
            {
              quoted: message
            }
          );

          continue;
        }

        try {
          const url = normalizeUrl(argument);

          await sock.sendMessage(
            jid,
            {
              text: "⏳ Memproses bypass..."
            },
            {
              quoted: message
            }
          );

          const resultUrl = await bypass(url);

          await sock.sendMessage(
            jid,
            {
              text: resultUrl
            },
            {
              quoted: message
            }
          );

        } catch (error) {
          console.error("Bypass error:", error);

          await sock.sendMessage(
            jid,
            {
              text: `❌ ${
                error.name === "AbortError"
                  ? "Request timeout."
                  : error.message
              }`
            },
            {
              quoted: message
            }
          );
        }
      }
    }
  );

  return sock;
}

process.on("SIGTERM", () => {
  stopping = true;
  clearTimeout(reconnectTimer);
  process.exit(0);
});

process.on("SIGINT", () => {
  stopping = true;
  clearTimeout(reconnectTimer);
  process.exit(0);
});

startBot().catch(error => {
  console.error("Bot gagal dijalankan:", error);
  process.exit(1);
});
