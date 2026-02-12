import express from "express"
import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason
} from "@whiskeysockets/baileys"
import qrcode from "qrcode-terminal"

const PORT = process.env.PORT || 3000
const PHONE_NUMBER = process.env.PHONE_NUMBER
const PAIR_TYPE = process.env.PAIR_TYPE || "QR"

const app = express()
app.use(express.json())

let sock = null
let isConnected = false
let isPairingRequested = false

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

/* =========================
   MODE: PAIRING CODE
========================= */

function formatJid(number) {
  const cleaned = number.replace(/^0/, "62")
  return `${cleaned}@s.whatsapp.net`
}

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

  sock.ev.on("creds.update", saveCreds)

  sock.ev.on("connection.update", async ({ connection, lastDisconnect }) => {

    if (connection === "open") {
      isConnected = true
    }

    if (connection === "close") {
      isConnected = false
      const status = lastDisconnect?.error?.output?.statusCode
      if (status !== DisconnectReason.loggedOut) {
        setTimeout(initWithCode, 3000)
      }
    }
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

const jid = (to) =>
  to.replace(/^0/, "62") + "@s.whatsapp.net"

async function initWithQR() {
  const { state, saveCreds } = await useMultiFileAuthState("auth")
  const { version } = await fetchLatestBaileysVersion()

  sock = makeWASocket({
    version,
    auth: state,
    browser: ["Windows", "Chrome", "120.0.0"],
    syncFullHistory: false,
    logger: silentLogger
  })

  sock.ev.on("creds.update", saveCreds)

  sock.ev.on("connection.update", ({ qr, connection, lastDisconnect }) => {

    if (qr) {
      console.clear()
      qrcode.generate(qr, { small: true })
    }

    if (connection === "open") {
      isConnected = true
    }

    if (connection === "close") {
      isConnected = false
      const status = lastDisconnect?.error?.output?.statusCode
      if (status !== DisconnectReason.loggedOut) {
        setTimeout(initWithQR, 3000)
      }
    }
  })
}

/* =========================
   SEND ENDPOINT
========================= */

app.post("/send", async (req, res) => {
  try {
    const { to, msg } = req.body

    if (!to || !msg) {
      return res.status(400).json({ status: "error" })
    }

    if (!sock || !isConnected) {
      return res.status(503).json({ status: "error" })
    }

    const target =
      PAIR_TYPE === "CODE"
        ? formatJid(to)
        : jid(to)

    const result = await sock.sendMessage(target, { text: msg })

    console.log(`sent to ${to}: ${msg}`)

    return res.json({
      status: "sent",
      to,
      msg
    })

  } catch (err) {
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
  if (PAIR_TYPE === "CODE") {
    await initWithCode()
  } else {
    await initWithQR()
  }

  app.listen(PORT)
}

start()
