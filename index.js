import express from "express"
import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason
} from "@whiskeysockets/baileys"
import qrcode from "qrcode-terminal"

import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3"
import fs from "fs"
import archiver from "archiver"
import unzipper from "unzipper"

const PORT = process.env.PORT || 3000
const PHONE_NUMBER = process.env.PHONE_NUMBER
const PAIR_TYPE = process.env.PAIR_TYPE || "QR"

const app = express()
app.use(express.json())

let sock = null
let isConnected = false
let isPairingRequested = false
let pairingRetryTimer = null
let hasLoggedPairingSuccess = false
const PAIRING_TIMEOUT = 20 * 1000

/* =========================
   R2 CONFIG
========================= */

const r2 = new S3Client({
  region: "auto",
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY,
    secretAccessKey: process.env.R2_SECRET_KEY
  }
})

const bucket = process.env.R2_BUCKET
const key = process.env.R2_KEY || "auth.zip"

let uploadTimer = null
let isUploading = false

async function uploadAuth() {
  const output = fs.createWriteStream("auth.zip")
  const archive = archiver("zip")

  archive.pipe(output)
  archive.directory("auth/", false)
  await archive.finalize()

  await new Promise(resolve => output.on("close", resolve))

  const fileStream = fs.createReadStream("auth.zip")

  await r2.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: fileStream
  }))
}

async function downloadAuth() {
  try {
    if (!fs.existsSync("auth")) {
      fs.mkdirSync("auth")
    }

    const data = await r2.send(new GetObjectCommand({
      Bucket: bucket,
      Key: key
    }))

    await new Promise((resolve, reject) => {
      data.Body
        .pipe(unzipper.Extract({ path: "./auth" }))
        .on("close", resolve)
        .on("error", reject)
    })

    console.log("Auth restored from R2")
  } catch {
    console.log("No existing auth in R2")
  }
}

function scheduleUpload() {
  if (uploadTimer) return

  uploadTimer = setTimeout(async () => {
    if (isUploading) return
    try {
      isUploading = true
      await uploadAuth()
      console.log("Auth uploaded to R2")
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

const jid = (to) =>
  to.replace(/^0/, "62") + "@s.whatsapp.net"

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

  sock.ev.on("connection.update", async ({ connection, lastDisconnect }) => {

    if (connection === "open") {
      isConnected = true

      if (!hasLoggedPairingSuccess) {
        console.log("Pairing success. WhatsApp connected.")
        hasLoggedPairingSuccess = true
      }

      if (pairingRetryTimer) {
        clearTimeout(pairingRetryTimer)
        pairingRetryTimer = null
      }

      isPairingRequested = false
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

        pairingRetryTimer = setTimeout(() => {
          if (!isConnected) {
            console.log("Pairing window expired (20s). No regeneration.")
          }
        }, PAIRING_TIMEOUT)

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
    syncFullHistory: false,
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
