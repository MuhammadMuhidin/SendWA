import express from "express"
import {
  makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason
} from "baileys"

const PHONE = process.env.PHONE_NUMBER
if (!PHONE) {
  console.error("PHONE_NUMBER belum di-set (628xxxx)")
  process.exit(1)
}

const app = express()
app.use(express.json())

let sock

const jid = (to) =>
  to.replace(/^0/, "62") + "@s.whatsapp.net"

async function startWA() {
  const { state, saveCreds } = await useMultiFileAuthState("auth")
  const { version } = await fetchLatestBaileysVersion()

  sock = makeWASocket({ version, auth: state })

  sock.ev.on("creds.update", saveCreds)

  sock.ev.on("connection.update", async ({ connection, lastDisconnect }) => {
    if (connection === "open") {
      console.log("WhatsApp connected")
    }

    if (connection === "close") {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut

      if (shouldReconnect) startWA()
    }
  })

  if (!state.creds.registered) {
    const code = await sock.requestPairingCode(PHONE)
    console.log("Pairing code:", code)
  }
}

app.post("/send", async (req, res) => {
  try {
    const { to, msg } = req.body
    if (!to || !msg)
      return res.status(400).json({ error: "to dan msg wajib" })

    await sock.sendMessage(jid(to), { text: msg })

    console.log(`sent to ${to} with msg ${msg}`)
    res.json({ status: "sent" })
  } catch {
    res.status(500).json({ error: "failed" })
  }
})

await startWA()

app.listen(3000, () => {
  console.log("Server running on 3000")
})
