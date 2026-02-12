# WhatsApp Sender API (Baileys)

Simple Express API untuk mengirim pesan WhatsApp menggunakan **Baileys**.  
Mendukung dua metode autentikasi:

- **QR Mode** → Scan QR dari terminal
- **Pairing Code Mode** → Masukkan kode pairing ke WhatsApp

---

## Requirements

- Node.js 18+
- Nomor WhatsApp aktif
- Koneksi internet stabil

---

## Installation

Clone repository lalu install dependency:

```bash
npm install
```

---

## Running the App

### QR Mode

```bash
PAIR_TYPE=QR node index.js
```

QR akan muncul di terminal. Scan menggunakan WhatsApp Anda.

---

### Pairing Code Mode

```bash
PAIR_TYPE=CODE PHONE_NUMBER=62888xxxx node index.js
```

Kode pairing akan muncul di terminal.  
Masukkan kode tersebut di aplikasi WhatsApp Anda.

---

## API Endpoint

### Send Message

**POST** `/send`

**Headers**
```
Content-Type: application/json
```

**Body**
```json
{
  "to": "62888xxxx",
  "msg": "Hello world"
}
```

---

### Example (curl)

```bash
curl -X POST http://localhost:3000/send \
  -H "Content-Type: application/json" \
  -d "{\"to\":\"62888xxxx\",\"msg\":\"Test message\"}"
```

---

### Success Response

```json
{
  "status": "sent",
  "to": "62888xxxx",
  "msg": "Test message",
  "messageId": "xxxxx"
}
```

---

## Project Structure

```
.
├── index.js
├── package.json
└── auth/              # Auto-generated session folder
```

- `index.js` → Main application entry  
- `auth/` → WhatsApp session storage (auto created)

---

## Session Behavior

- Folder `auth` menyimpan session login.
- Jangan hapus folder ini jika ingin tetap login.
- Jika logout atau session rusak, hapus folder `auth` lalu jalankan ulang.

---

## Deployment Notes

Jika deploy ke Koyeb, Railway, VPS, atau server lain:

- Gunakan `process.env.PORT`
- Pastikan port terbuka ke public
- Gunakan persistent storage untuk folder `auth` agar session tidak hilang saat restart

---

## Troubleshooting

### Could not resolve host
Biasanya karena:
- Server tidak running
- Port belum expose/public
- Salah copy domain

### 503 Service Unavailable
Socket belum terhubung ke WhatsApp. Tunggu sampai koneksi `open`.

### Logged out
Hapus folder `auth` lalu jalankan ulang.

---