import express from "express"
import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion
} from "@whiskeysockets/baileys"

const PORT = 3000
const PHONE = process.env.PHONE_NUMBER

if (!PHONE) {
  console.error("PHONE_NUMBER env belum di-set (format 628xxxx)")
  process.exit(1)
}

const app = express()
app.use(express.json())

let sock

const formatJid = (to) =>
  to.replace(/^0/, "62") + "@s.whatsapp.net"

async function initWA() {
  const { state, saveCreds } = await useMultiFileAuthState("auth")
  const { version } = await fetchLatestBaileysVersion()

  sock = makeWASocket({
    version,
    auth: state
  })

  sock.ev.on("creds.update", saveCreds)

  sock.ev.on("connection.update", async ({ connection }) => {
    if (connection === "open") {
      console.log("WhatsApp connected")
    }

    if (!state.creds.registered) {
      const code = await sock.requestPairingCode(PHONE)
      console.log("Pairing code:", code)
    }
  })
}

app.post("/send", async (req, res) => {
  try {
    const { to, msg } = req.body
    if (!to || !msg)
      return res.status(400).json({ error: "to dan msg wajib" })

    const jid = formatJid(to)

    await sock.sendMessage(jid, { text: msg })

    console.log(`sent to ${to} with msg ${msg}`)

    res.json({ status: "sent" })
  } catch (err) {
    res.status(500).json({ error: "failed" })
  }
})

await initWA()

app.listen(PORT, () => {
  console.log(`Server running on ${PORT}`)
})
