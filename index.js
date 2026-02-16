import express from "express"
import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason
} from "@whiskeysockets/baileys"
import qrcode from "qrcode-terminal"

import { Pool } from "pg"
import fs from "fs"
import path from "path"

const PORT = process.env.PORT || 3000
const PHONE_NUMBER = process.env.PHONE_NUMBER
const PAIR_TYPE = process.env.PAIR_TYPE || "QR"
const DATABASE_URL = process.env.SPBASE_URI

const app = express()
app.use(express.json())

let sock = null
let isConnected = false
let isPairingRequested = false

// health & lifecycle state
let lastConnectedAt = null
let lastDisconnectAt = null
let isLoggedOut = false
let requiresRePair = false

/* =========================
   POSTGRES CONFIG
========================= */

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
})

async function uploadAuth() {
  if (!fs.existsSync("auth")) return

  const files = fs.readdirSync("auth")
  const data = {}

  for (const file of files) {
    const content = fs.readFileSync(path.join("auth", file))
    data[file] = content.toString("base64")
  }

  await pool.query(
    `
    INSERT INTO wa_session (id, data)
    VALUES ($1, $2)
    ON CONFLICT (id)
    DO UPDATE SET data = $2, updated_at = NOW()
    `,
    ["main", JSON.stringify(data)]
  )

  //console.log("Auth uploaded to PostgreSQL")
}

async function downloadAuth() {
  try {
    if (!fs.existsSync("auth")) {
      fs.mkdirSync("auth")
    }

    const result = await pool.query(
      "SELECT data FROM wa_session WHERE id = $1",
      ["main"]
    )

    if (result.rows.length === 0) {
      console.log("No existing auth in DB")
      return
    }

    const data = JSON.parse(result.rows[0].data)

    for (const file in data) {
      const buffer = Buffer.from(data[file], "base64")
      fs.writeFileSync(path.join("auth", file), buffer)
    }

    //console.log("Auth restored from PostgreSQL")

  } catch (err) {
    console.log("DB restore failed:", err.message)
  }
}

let uploadTimer = null
let isUploading = false

function scheduleUpload() {
  if (uploadTimer) return

  uploadTimer = setTimeout(async () => {
    if (isUploading) return

    try {
      isUploading = true
      await uploadAuth()
    } catch (err) {
      console.log("Upload failed:", err.message)
    } finally {
      isUploading = false
      uploadTimer = null
    }
  }, 8000)
}

/* =========================
   COMMON
========================= */

const silentLogger = {
  level: "silent",
  child() { return this },
  info() {},
  error() {},
  warn() {},
  debug() {},
  trace() {},
  fatal() {}
}

function formatJid(number) {
  const cleaned = number.replace(/^0/, "62")
  return `${cleaned}@s.whatsapp.net`
}

/* =========================
   CONNECTION HANDLER
========================= */

function handleConnectionUpdate(connection, lastDisconnect, reconnectFn) {
  if (connection === "open") {
    isConnected = true
    isLoggedOut = false
    requiresRePair = false
    lastConnectedAt = Date.now()
  }

  if (connection === "close") {
    isConnected = false
    lastDisconnectAt = Date.now()

    const status = lastDisconnect?.error?.output?.statusCode

    if (status === DisconnectReason.loggedOut) {
      isLoggedOut = true
      requiresRePair = true
      console.log("Device unpaired (logged out)")
      return
    }

    setTimeout(reconnectFn, 3000)
  }
}

/* =========================
   MODE: CODE
========================= */

async function initWithCode() {
  const { state, saveCreds } = await useMultiFileAuthState("auth")
  const { version } = await fetchLatestBaileysVersion()

  sock = makeWASocket({
    version,
    auth: state,
    browser: ["Ubuntu", "Chrome", "120.0.0"],
    printQRInTerminal: false,
    logger: silentLogger
  })

  sock.ev.on("creds.update", async () => {
    await saveCreds()
    scheduleUpload()
  })

  sock.ev.on("connection.update", ({ connection, lastDisconnect }) => {
    handleConnectionUpdate(connection, lastDisconnect, initWithCode)
  })

  if (!state.creds.registered && !isPairingRequested) {
    if (!PHONE_NUMBER) process.exit(1)

    isPairingRequested = true

    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(PHONE_NUMBER)
        console.log("Pairing code:", code)
      } catch {
        isPairingRequested = false
      }
    }, 5000)
  }
}

/* =========================
   MODE: QR
========================= */

async function initWithQR() {
  const { state, saveCreds } = await useMultiFileAuthState("auth")
  const { version } = await fetchLatestBaileysVersion()

  sock = makeWASocket({
    version,
    auth: state,
    browser: ["Windows", "Chrome", "120.0.0"],
    logger: silentLogger
  })

  sock.ev.on("creds.update", async () => {
    await saveCreds()
    scheduleUpload()
  })

  sock.ev.on("connection.update", ({ qr, connection, lastDisconnect }) => {

    if (qr) {
      console.clear()
      qrcode.generate(qr, { small: true })
    }

    handleConnectionUpdate(connection, lastDisconnect, initWithQR)
  })
}

/* =========================
   HEALTH CHECK
========================= */

async function isHealthy() {
  if (!sock) return false
  if (requiresRePair) return false
  if (isLoggedOut) return false

  if (!isConnected) {
    if (lastDisconnectAt && Date.now() - lastDisconnectAt < 60000) {
      return true
    }
    return false
  }

  try {
    await pool.query("SELECT 1")
  } catch {
    return false
  }

  return true
}

app.get("/health", async (req, res) => {
  const healthy = await isHealthy()

  if (!healthy) {
    return res.status(500).json({
      status: "unhealthy",
      connected: isConnected,
      paired: !requiresRePair,
      requiresRePair
    })
  }

  res.json({
    status: "healthy",
    connected: true,
    paired: true
  })
})

/* =========================
   MANUAL REPAIR TRIGGER
========================= */

app.get("/repair", async (req, res) => {
  if (!requiresRePair) {
    return res.status(400).json({ status: "not_required" })
  }

  try {
    if (fs.existsSync("auth")) {
      fs.rmSync("auth", { recursive: true, force: true })
    }

    await pool.query("DELETE FROM wa_session WHERE id = $1", ["main"])

    requiresRePair = false
    isLoggedOut = false
    isPairingRequested = false

    if (PAIR_TYPE === "CODE") {
      await initWithCode()
    } else {
      await initWithQR()
    }

    return res.json({ status: "repair_started" })
  } catch (err) {
    return res.status(500).json({ status: "error", message: err.message })
  }
})

/* =========================
   PROTECT SEND ENDPOINT
========================= */

function protectSend(req, res, next) {
  const apiKey = req.headers["x-api-key"]

  if (!process.env.SEND_API_KEY) {
    return res.status(500).json({ status: "server misconfiguration!" })
  }

  if (!apiKey || apiKey !== process.env.SEND_API_KEY) {
    return res.status(401).json({ status: "unauthorized!" })
  }

  next()
}

/* =========================
   SEND ENDPOINT
========================= */

app.post("/send", protectSend, async (req, res) => {
  try {
    const { to, msg } = req.body

    if (!to || !msg) {
      return res.status(400).json({ status: "error" })
    }

    if (!sock || !isConnected) {
      return res.status(503).json({ status: "error" })
    }

    const target = formatJid(to)

    await sock.sendMessage(target, { text: msg })

    console.log(`sent to ${to} ${msg}`)

    return res.json({
      status: "sent",
      to,
      msg
    })

  } catch (err) {
    console.log("send error:", err?.message)
    return res.status(500).json({
      status: "error",
      message: err?.message || "failed"
    })
  }
})

/* =========================
   START
========================= */

async function start() {
  await downloadAuth()

  if (PAIR_TYPE === "CODE") {
    await initWithCode()
  } else {
    await initWithQR()
  }

  app.listen(PORT)
}

start()
