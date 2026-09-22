# CLI-to-Web 🖥️

Browser-based terminal untuk akses remote server tanpa port forwarding.

```
Browser  <──WSS──>  Relay Server (VPS)  <──WSS──>  Agent (Home Server/STB)
```

## Arsitektur

| Komponen | Lokasi | Fungsi |
|----------|--------|--------|
| **Relay Server** | VPS publik (Hostinger) | Jembatan WebSocket antara browser & agent |
| **Agent** | Home server / STB Armbian | Spawn shell lokal, kirim output ke relay |
| **Web UI** | Browser | Terminal interaktif via xterm.js |

Agent selalu connect **keluar** ke relay — tidak perlu IP publik atau port forwarding di rumah.

---

## Quick Start

### 1. Setup Relay Server (di VPS)

```bash
cd relay-server
npm install

# Generate password hash untuk login Web UI
node -e "require('bcryptjs').hash('passwordkamu',10).then(h=>console.log(h))"

# Buat .env
cp .env.example .env
# Edit .env: isi RELAY_SECRET, WEB_PASS_HASH, SESSION_SECRET

# Jalankan
npm start
```

### 2. Generate Token untuk Agent

```bash
# Dari browser atau curl (setelah login):
curl -b cookies.txt https://terminal.yourdomain.com/api/generate-token?name=stb-rumah
# Output: { "agentId": "stb-rumah-a1b2c3d4", "token": "stb-rumah-a1b2c3d4:hmac..." }
```

### 3. Setup Agent (di STB / Home Server)

```bash
cd agent
npm install

# Buat .env
cp .env.example .env
# Edit .env:
#   RELAY_URL=wss://terminal.yourdomain.com/ws/agent
#   AGENT_TOKEN=<token dari step 2>

# Test jalankan
node agent.js

# Install sebagai systemd service
sudo cp cliweb-agent.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now cliweb-agent
```

### 4. Buka Browser

Buka `https://terminal.yourdomain.com`, login, klik agent yang online → terminal interaktif!

---

## Deploy Relay Server dengan Nginx

```bash
# Copy config
sudo cp deploy/nginx.conf /etc/nginx/sites-available/terminal.yourdomain.com
sudo ln -sf /etc/nginx/sites-available/terminal.yourdomain.com /etc/nginx/sites-enabled/

# SSL via certbot
sudo certbot --nginx -d terminal.yourdomain.com

# Reload
sudo nginx -t && sudo systemctl reload nginx
```

Atau pakai **Caddy** (TLS otomatis):
```bash
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile
sudo systemctl restart caddy
```

---

## Deploy Relay Server dengan Cloudflare Tunnel

Jika relay server di belakang Cloudflare Tunnel (seperti setup Harun):

1. Tambah hostname di `/etc/cloudflared/config.yml`:
   ```yaml
   - hostname: terminal.albiontools.fun
     service: http://127.0.0.1:3100
   ```

2. Restart cloudflared: `sudo systemctl restart cloudflared`

3. Tambah CNAME di Cloudflare DNS:
   - Name: `terminal`
   - Target: `<tunnel-id>.cfargotunnel.com`
   - Proxy: ✓

---

## Struktur Folder

```
cli-to-web/
├── relay-server/
│   ├── package.json
│   ├── .env.example
│   ├── src/
│   │   └── server.js          ← relay + HTTP API + auth
│   └── public/
│       └── index.html          ← Web UI (login + agent list + xterm.js)
├── agent/
│   ├── package.json
│   ├── .env.example
│   ├── agent.js                ← PTY agent with auto-reconnect
│   └── cliweb-agent.service    ← systemd unit file
├── deploy/
│   ├── Caddyfile
│   └── nginx.conf
└── README.md
```

---

## Keamanan (MVP)

- ✅ WebSocket pakai WSS (via reverse proxy TLS)
- ✅ Agent autentikasi dengan HMAC token
- ✅ Web UI dilindungi login (username + bcrypt password)
- ✅ Rate limiting login (5 attempts/menit per IP)
- ✅ Session cookie HttpOnly + SameSite=Strict
- ✅ Auto-cleanup terminal session saat browser disconnect

---

## Troubleshooting

| Masalah | Solusi |
|---------|--------|
| Agent tidak bisa connect | Cek RELAY_URL (harus `wss://`) dan AGENT_TOKEN |
| 403 saat agent connect | Token salah atau RELAY_SECRET berbeda |
| Terminal tidak responsif | Cek agent log: `journalctl -u cliweb-agent -f` |
| Login gagal terus | Generate ulang WEB_PASS_HASH, pastikan format bcrypt |
