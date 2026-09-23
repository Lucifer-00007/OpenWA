# Native VPS deployment (without Docker)

This guide deploys OpenWA on one Linux VPS without Docker:

- **OpenWA API** runs as a `systemd` service on port `2785`.
- **Dashboard** is built once and served as static files by Nginx.
- **Nginx** exposes one HTTPS origin, serves the dashboard, and proxies `/api/` and `/socket.io/` to the API.
- **PostgreSQL** stores application data; the small local `data/main.sqlite` database stores API keys and audit records.
- **Redis** is optional, but recommended when enabling background webhook queues.

The API does **not** serve the dashboard build itself. They are separate processes/artifacts, but they should normally share one domain, such as `https://wa.example.com`.

> Commands below target Ubuntu/Debian and use `/opt/openwa`. Substitute your domain and SSH user. Run application commands as the `openwa` user, not as `root`.

## 1. Prepare DNS, firewall, and server packages

Create an `A`/`AAAA` DNS record for `wa.example.com` that points to the VPS. Before requesting a TLS certificate, ensure ports 80 and 443 are reachable from the Internet.

```bash
sudo apt update
sudo apt install -y ca-certificates curl git nginx postgresql redis-server rsync certbot python3-certbot-nginx
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node --version
npm --version
```

Allow only SSH, HTTP, and HTTPS through the host firewall. The API port should remain private.

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw deny 2785/tcp
sudo ufw enable
```

Create an unprivileged service user and directories. The `data` directory contains WhatsApp session credentials, media, SQLite state, and the first admin API key—treat it as sensitive persistent data.

```bash
sudo useradd --system --create-home --home-dir /opt/openwa --shell /usr/sbin/nologin openwa
sudo install -d -o openwa -g openwa -m 0750 /opt/openwa /opt/openwa/data/{sessions,media,plugins}
sudo install -d -o openwa -g openwa -m 0755 /var/www/openwa-dashboard
```

## 2. Create the PostgreSQL database

For a production deployment, use PostgreSQL. It can be on the same VPS for a small installation, but should be a managed or separate private database for higher availability.

```bash
sudo -u postgres createuser --pwprompt openwa
sudo -u postgres createdb --owner=openwa openwa
```

Choose a long, unique password at the prompt. Keep PostgreSQL bound to localhost/private networking; do not expose port 5432 publicly. The current application uses the PostgreSQL database name `openwa`, so retain that name.

## 3. Configure Redis (optional)

Use Redis only when you need cached data or async webhook queues. Bind it locally and protect it with a password if other local users/processes are not fully trusted.

```bash
sudo sed -i 's/^bind .*/bind 127.0.0.1 ::1/' /etc/redis/redis.conf
sudo systemctl enable --now redis-server postgresql
sudo systemctl status redis-server postgresql --no-pager
```

To enable queues later, set `REDIS_ENABLED=true` and `QUEUE_ENABLED=true` in the API environment and restart the API. Do not enable queues unless Redis is running and reachable.

## 4. Install OpenWA and its dependencies

Clone a specific reviewed tag or commit in production rather than tracking an unreviewed branch.

```bash
sudo -u openwa git clone https://github.com/rmyndharis/OpenWA.git /opt/openwa/app
cd /opt/openwa/app
sudo -u openwa git checkout <reviewed-tag-or-commit>
sudo -u openwa npm ci
```

`npm ci` also installs the dashboard dependencies through the project post-install script.

## 5. Add the API environment file

Create `/etc/openwa/openwa.env` with restrictive permissions:

```bash
sudo install -d -m 0750 /etc/openwa
sudoedit /etc/openwa/openwa.env
sudo chown root:openwa /etc/openwa/openwa.env
sudo chmod 0640 /etc/openwa/openwa.env
```

Use this baseline. Replace every value marked `CHANGE_ME`. Do not put quotes around values unless they are intended to become part of the value.

```env
NODE_ENV=production
PORT=2785
BASE_URL=https://wa.example.com
DASHBOARD_URL=https://wa.example.com
CORS_ORIGINS=https://wa.example.com

# PostgreSQL application data
DATABASE_TYPE=postgres
DATABASE_HOST=127.0.0.1
DATABASE_PORT=5432
DATABASE_NAME=openwa
DATABASE_USERNAME=openwa
DATABASE_PASSWORD=CHANGE_ME_TO_THE_POSTGRES_PASSWORD
DATABASE_SSL=false
DATABASE_SYNCHRONIZE=false
DATABASE_POOL_SIZE=10

# OpenWA still uses this local SQLite file for API keys and audit records.
# It is relative to WorkingDirectory and must remain on persistent storage.
DATABASE_LOGGING=false

# WhatsApp browser/session data
ENGINE_TYPE=whatsapp-web.js
SESSION_DATA_PATH=/opt/openwa/app/data/sessions
PUPPETEER_HEADLESS=true
PUPPETEER_ARGS=--no-sandbox,--disable-setuid-sandbox,--disable-dev-shm-usage,--disable-gpu

# Local media storage (use an absolute, writable persistent path)
STORAGE_TYPE=local
STORAGE_LOCAL_PATH=/opt/openwa/app/data/media

# Redis and queues: leave disabled unless Redis is configured
REDIS_ENABLED=false
REDIS_HOST=127.0.0.1
REDIS_PORT=6379
CACHE_ENABLED=false
QUEUE_ENABLED=false

# Webhooks and rate limits
WEBHOOK_TIMEOUT=10000
WEBHOOK_MAX_RETRIES=3
WEBHOOK_RETRY_DELAY=5000
RATE_LIMIT_SHORT_TTL=1000
RATE_LIMIT_SHORT_LIMIT=10
RATE_LIMIT_MEDIUM_TTL=60000
RATE_LIMIT_MEDIUM_LIMIT=100
RATE_LIMIT_LONG_TTL=3600000
RATE_LIMIT_LONG_LIMIT=1000

# Used to encrypt automation-provider secrets. Generate a unique high-entropy value.
AUTOMATION_SECRET_KEY=CHANGE_ME_TO_A_LONG_RANDOM_SECRET
```

Generate a value for `AUTOMATION_SECRET_KEY`, then paste it into the file:

```bash
openssl rand -hex 32
```

### Storage choices

Keep `STORAGE_TYPE=local` for a single VPS and include `/opt/openwa/app/data/media` in backups. For S3-compatible storage instead, replace the local-storage block with:

```env
STORAGE_TYPE=s3
S3_ENDPOINT=https://s3.example.com
S3_REGION=us-east-1
S3_BUCKET=openwa-production
S3_ACCESS_KEY=CHANGE_ME
S3_SECRET_KEY=CHANGE_ME
```

Use a private bucket, least-privilege credentials limited to that bucket, server-side encryption, versioning, and a lifecycle policy. Verify the endpoint is reachable from the VPS before enabling it.

## 6. Build backend and dashboard

```bash
cd /opt/openwa/app
sudo -u openwa npm run build
sudo -u openwa npm run dashboard:build
sudo rsync -a --delete dashboard/dist/ /var/www/openwa-dashboard/
sudo chown -R openwa:openwa /var/www/openwa-dashboard
```

The backend build is `dist/`; the dashboard build is `dashboard/dist/`. Nginx serves the latter. Run these commands for every application release.

## 7. Run the API with systemd

Create `/etc/systemd/system/openwa.service`:

```ini
[Unit]
Description=OpenWA API
After=network-online.target postgresql.service redis-server.service
Wants=network-online.target

[Service]
Type=simple
User=openwa
Group=openwa
WorkingDirectory=/opt/openwa/app
EnvironmentFile=/etc/openwa/openwa.env
ExecStart=/usr/bin/node /opt/openwa/app/dist/main.js
Restart=on-failure
RestartSec=5
TimeoutStopSec=30
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=full
ReadWritePaths=/opt/openwa/app/data

[Install]
WantedBy=multi-user.target
```

Load and start it:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now openwa
sudo systemctl status openwa --no-pager
curl http://127.0.0.1:2785/api/health
```

On first startup, OpenWA creates a default admin API key, logs it, and writes it to `data/.api-key`. Save it immediately in a password manager and restrict its use. Do not paste it into shell history, source control, or support tickets.

```bash
sudo journalctl -u openwa -b | grep -A2 'API Key'
```

## 8. Configure Nginx and HTTPS

Create `/etc/nginx/sites-available/openwa` and replace the domain:

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name wa.example.com;
    root /var/www/openwa-dashboard;
    index index.html;

    location /api/ {
        proxy_pass http://127.0.0.1:2785;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /socket.io/ {
        proxy_pass http://127.0.0.1:2785;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

Enable it, test the configuration, and request the certificate:

```bash
sudo ln -s /etc/nginx/sites-available/openwa /etc/nginx/sites-enabled/openwa
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx
sudo certbot --nginx -d wa.example.com --redirect --agree-tos -m admin@example.com
sudo systemctl enable --now certbot.timer
```

Nginx serves the dashboard and proxies API/WebSocket requests on the same origin. This avoids needing a public API port and means `CORS_ORIGINS` can be exactly `https://wa.example.com`.

## 9. Verify the deployment

```bash
curl -f https://wa.example.com/api/health
curl -I https://wa.example.com/
sudo systemctl is-active openwa nginx postgresql
sudo journalctl -u openwa -n 100 --no-pager
```

Open `https://wa.example.com`, enter the first admin API key, create a session, and scan its QR code with WhatsApp. API documentation is available at `https://wa.example.com/api/docs`.

## 10. Backups, upgrades, and routine operations

Back up all of the following: PostgreSQL, `/opt/openwa/app/data` (especially `sessions`, `main.sqlite`, and `.api-key`), and the environment file from `/etc/openwa`. Encrypt backups and store a copy off the VPS.

Example PostgreSQL backup:

```bash
sudo -u postgres pg_dump -Fc openwa > /var/backups/openwa-$(date +%F).dump
```

For an upgrade, first back up, then use a reviewed release. Build before restarting, so a failed build does not interrupt the live service:

```bash
cd /opt/openwa/app
sudo -u openwa git fetch --tags
sudo -u openwa git checkout <reviewed-new-tag>
sudo -u openwa npm ci
sudo -u openwa npm run build
sudo -u openwa npm run dashboard:build
sudo rsync -a --delete dashboard/dist/ /var/www/openwa-dashboard/
sudo systemctl restart openwa
sudo nginx -t && sudo systemctl reload nginx
curl -f https://wa.example.com/api/health
```

Review release notes and database migration requirements before every upgrade. Monitor the service with `sudo journalctl -u openwa -f`, keep OS/Node dependencies patched, and periodically test restoring a backup to a separate environment.
