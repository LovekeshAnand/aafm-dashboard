# Deployment plan (Prompt 55)

Target (user, Prompt 55):
- backend on an **EC2** instance;
- frontend on **Cloudflare Workers**;
- database on **Neon**.

Status: **database decided: Postgres 18 in Docker on the EC2 instance** (Prompt 56, "for full control"), not Neon. The Neon findings below are kept as the record of why. Nothing is deployed yet.

What the Docker decision settles:
- The owner role is a real superuser (#8 met).
- LISTEN/NOTIFY works.
- No compute-hour limit.
- The database is on an internal Docker network with no public port.

What it adds:
- Backups are now ours: `deploy/scripts/backup.sh`, a nightly `pg_dump` with 7 kept. Copy them off the instance (e.g. S3) for disaster recovery.

---

## 1. Findings that shape the design

### Neon (database)
- **Owner rights: OK.** Roles created in the Neon Console belong to `neon_superuser`, which has **BYPASSRLS** and **CREATEROLE** (for projects created after 15 Aug 2023) ([Neon roles](https://neon.com/docs/manage/roles)).
  - That's what our cross-tenant jobs need (problems-log #8). The startup check (`src/db/preflight.js`) will confirm it on the real database.
- **Pooled connections: not usable for us.** Neon's pooler is PgBouncer in transaction mode, which does **not** support LISTEN/NOTIFY, session-level advisory locks or `SET` ([Neon pooling](https://neon.com/docs/connect/connection-pooling)). The Socket.IO Postgres adapter needs LISTEN.
  - Our code is otherwise pooler-safe (only transaction-local settings and transaction-level locks).
  - So we use the **direct** (non-pooled) connection string. At our size (API pool of 10) that's well within limits.
- **Free plan vs. 24/7 real-time: this is the main problem.**
  - Neon Free gives **100 CU-hours per project per month** ([Neon plans](https://neon.com/docs/introduction/plans)).
  - Compute scales to zero after **5 minutes** of inactivity, and on Free this can't be changed ([scale to zero](https://neon.com/docs/introduction/scale-to-zero)).
  - Our backend touches the database constantly:
    - a simulator tick every 5 s;
    - webhook polling every 2 s;
    - housekeeping every 5 min;
    - the Socket.IO adapter's heartbeat.
  - So the compute never sleeps: 24 h × 30 d × 0.25 CU ≈ **180 CU-h/month**, about **1.8× the free allowance**.
  - When the allowance runs out, the compute is **suspended until the next billing period** and connections fail ([Neon plans](https://neon.com/docs/introduction/plans)). The live site would go down around day 16 of the month.

### Cloudflare Workers (frontend)
- **Next.js 16 is supported** by the OpenNext Cloudflare adapter, including Partial Prerendering and `use cache`. It needs the Node.js runtime ([OpenNext Cloudflare](https://opennext.js.org/cloudflare)).
- **The browser must reach the API and the WebSocket on the same site as the app.**
  - Our session cookie is `SameSite=Strict` and `HttpOnly` (deliberately: CSRF and XSS defence).
  - Proxying `/api` through the Worker is possible, but there's no documented way to proxy **WebSockets** through a Next rewrite on Workers.
- **Cloudflare can split one hostname by path:**
  - a route with **no Worker** attached sends that path to the origin server, overriding the broader Worker route ([Workers routes](https://developers.cloudflare.com/workers/configuration/routing/routes/));
  - Cloudflare proxies **WebSockets on all plans** ([Cloudflare WebSockets](https://developers.cloudflare.com/network/websockets/)).
- **This needs a domain on Cloudflare.** On a `*.workers.dev` address for the app plus a separate EC2 address for the API, the cookie would be cross-site. That would mean replacing cookie sessions with tokens readable by JavaScript, which is weaker against XSS.

### EC2 (backend)
- Nginx in front of Node (systemd or Docker) with TLS, as planned for problems-log #13.
- **Behind Cloudflare, the real client IP arrives in `CF-Connecting-IP`.**
  - Nginx should trust it **only from Cloudflare's published IP ranges**, and the security group should allow 443 **only from Cloudflare**.
  - Otherwise anyone could bypass Cloudflare and fake their IP to the sign-in rate limit.

## 2. Proposed architecture (if a Cloudflare domain is available)

```
                      app.<domain> (Cloudflare, proxied)
browser ──HTTPS──► Cloudflare edge
                     ├── /*            → Worker (Next.js via OpenNext)
                     ├── /api/*        → no Worker → origin: EC2 (Nginx → Express)
                     └── /socket.io*   → no Worker → origin: EC2 (WebSocket)
EC2 (Nginx, Cloudflare Origin CA cert, 443 open only to Cloudflare IPs)
  └── Node 24: API + workers (systemd), keyring file in /etc/aafm (mode 600)
Neon Postgres (direct connection, TLS)
```

What this keeps:
- one origin, so the cookie stays first-party and `SameSite=Strict`;
- no CORS;
- real-time works;
- the secret keyring never leaves the server;
- `TRUST_PROXY` set to 1 hop (Nginx), with Nginx turning `CF-Connecting-IP` into the client address.

## 3. What I can prepare here vs. what you must do

| I prepare (in the repo) | You do (accounts, keys, money) |
|---|---|
| `deploy/` folder:<br>• Nginx config (Cloudflare real-IP, WebSocket, timeouts, HSTS)<br>• systemd units for the API and worker<br>• server setup script<br>• `.env.production` template | Create the Neon project and copy its **direct** connection string |
| OpenNext/Wrangler config for the frontend; the build checked locally | Cloudflare: domain, DNS record to EC2, Origin CA certificate, Worker routes |
| Production checks (preflight, LZ4 support, migrations on Neon) | EC2: the instance, security group, SSH access |
| A step-by-step runbook with a verification step for each stage | Approve the git commit and push the server will deploy from (Rule 6) |

## 4. Decisions needed

1. **Neon Free vs. 24/7 real-time** (section 1).
2. **A domain on Cloudflare** (section 1).
3. **How commands reach the EC2 box.**
4. **Commit and push** so the server can pull the code.

---

## 6. Prepared in the repo (Prompt 56)

| File | Purpose |
|---|---|
| `backend/Dockerfile`, `backend/.dockerignore` | Production image: Node 24 Alpine, production dependencies only, non-root, `/ready` health check (it checks the DB) |
| `deploy/docker-compose.yml` | `db` (Postgres 18, internal network only), `api` (API + jobs), `nginx` (443) |
| `deploy/nginx/aafm.conf` | TLS (Cloudflare Origin CA); real client IP **only** from Cloudflare ranges; client `X-Forwarded-For` replaced, not appended; WebSocket upgrade; `X-Request-Id`; HSTS; everything outside `/api` and `/socket.io` → 404 |
| `deploy/scripts/update-cloudflare-ips.sh` | Generates the trusted-range list; refuses an empty download |
| `deploy/scripts/backup.sh` | Nightly `pg_dump`, keeps 7 |
| `deploy/.env.example`, `deploy/.gitignore` | Server secrets template; secrets, certs and backups never committed |
| `npm` scripts | `--env-file-if-exists`, so containers run without a `.env` file |
| `src/db/seed.js` | Production refuses to seed unless `ALLOW_DEMO_SEED=1` (the seed erases all data), so the demo org can be loaded on a fresh install on purpose |

## 7. Runbook (server side; frontend steps follow once the domain is known)

1. **EC2:**
   - Ubuntu 24.04, t3.small or larger (2 GB RAM for Postgres + Node);
   - security group: 443 from Cloudflare ranges only, 22 from your IP only.
2. **Install Docker:** `curl -fsSL https://get.docker.com | sh`, then `sudo usermod -aG docker ubuntu`.
3. **Code:** `git clone <repo> /opt/aafm`, then `cd /opt/aafm/deploy`.
4. **Secrets:**
   - `cp .env.example .env`, fill it in with `openssl rand -hex 32` values, `chmod 600 .env`;
   - `mkdir -p secrets certs backups`, then `sudo chown 1000:1000 secrets` (the container's `node` user).
5. **Certificate:** Cloudflare → SSL/TLS → Origin Server → Create certificate. Save the pair as `certs/origin.pem` and `certs/origin.key`; set SSL mode to **Full (strict)**.
6. **Trusted ranges:** `sh scripts/update-cloudflare-ips.sh`.
7. **Build and start the database:** `docker compose build && docker compose up -d db`.
8. **Migrate:** `docker compose run --rm api node src/db/migrate.js`. The preflight confirms the owner can bypass RLS.
9. **Keyring:** `docker compose run --rm api node scripts/keyring.js init`.
10. **Demo data (optional, fresh install only):** `docker compose run --rm -e ALLOW_DEMO_SEED=1 -e SEED_PASSWORD=<choose> api node src/db/seed.js`.
11. **Start:** `docker compose up -d`, then check `docker compose ps` (all healthy) and `docker compose logs api`.
12. **Verify from your machine:**
    - `curl -s https://<host>/api/v1/auth/me` → 401 JSON (the API answers through Cloudflare);
    - a WebSocket connects (browser);
    - `docker compose exec api node -e "fetch('http://127.0.0.1:8000/ready').then(r=>r.text()).then(console.log)"`.
13. **Cron:**
    - nightly `scripts/backup.sh`;
    - monthly `scripts/update-cloudflare-ips.sh && docker compose exec nginx nginx -s reload`.

## 8. Frontend on Cloudflare Workers (prepared and checked locally, Prompt 57)

- `@opennextjs/cloudflare` adapter, `wrangler.jsonc`, `open-next.config.ts`, `public/_headers` (immutable cache for `/_next/static/*`), and the scripts `npm run preview`, `deploy` and `upload`.
- **Checked here:** `opennextjs-cloudflare build` succeeds on this Windows machine. The Worker run locally in Cloudflare's runtime (`wrangler dev`) serves:
  - every page: 200;
  - static assets, with `Cache-Control: immutable`;
  - images;
  - the security headers (CSP `connect-src 'self'`).
- **Two problems found and fixed** (problems-log #54, #55):
  1. With Next's Cache Components on, the Worker hung on every request (500). Next itself warns it "cannot guarantee that Cache Components will run as expected" on this runtime. The flag is now off everywhere (dev = prod). The `instant` exports, which require it, are removed. The app renders signed-in pages in the browser anyway.
  2. `frontend/.env.local` sets `NEXT_PUBLIC_SOCKET_URL=http://localhost:8000`, and Next loads `.env.local` into production builds too, so the live site's real-time connection would have pointed at localhost. The direct socket URL is now used only in development.

### Runbook (you, once the hostname is known; examples use `app.example.com`)
1. **Sign in:** `cd frontend && npx wrangler login` (opens the browser; your Cloudflare account).
2. **Route:** in `wrangler.jsonc`, uncomment `routes` and set `"pattern": "app.example.com/*", "zone_name": "example.com"`.
3. **Deploy:** `npm run deploy`, which builds with OpenNext and uploads the Worker.
4. **DNS:** `A app → <EC2 public IP>`, **Proxied** (orange cloud). The origin is EC2, and the Worker route sits on top.
5. **No-Worker routes:** Workers Routes → Add route → `app.example.com/api/*` → Worker: **None**, and the same for `app.example.com/socket.io*`. The more specific route wins, so these paths go to EC2 ([Workers routes](https://developers.cloudflare.com/workers/configuration/routing/routes/)).
6. **TLS:**
   - SSL/TLS mode **Full (strict)**;
   - **Always Use HTTPS** on;
   - the Origin CA certificate on Nginx (server step 5).
7. **Backend origin:** set `CORS_ORIGIN=https://app.example.com` in `deploy/.env`, then `docker compose up -d api`.
8. **Verify:**
   - `https://app.example.com/login` loads (Worker);
   - `curl -s https://app.example.com/api/v1/auth/me` returns 401 JSON from Express (`X-Request-Id` present);
   - sign in; a dashboard shows **Live** (the WebSocket through Cloudflare to EC2);
   - `curl -sI https://app.example.com/login` shows the CSP and HSTS.

## 9. The actual instance (checked with ssh, Prompt 58)

- **Instance:** Amazon Linux 2023, x86_64, 2 vCPU, **913 MiB RAM, no swap, 8 GB disk** (`t3.micro` class).
- **Changes to the runbook:**
  - **Amazon Linux, not Ubuntu:** user `ec2-user`; Docker comes from `dnf`; the Compose and Buildx plugins are installed separately (step A below).
  - **Memory:** 2 GB swap file (step A), so a peak (image build, Postgres maintenance) can't trigger the out-of-memory killer.
  - **Disk:**
    - The simulator writes 20 points every 5 s, about 10 M rows over the 30-day retention (~2–2.5 GB with indexes), plus ~1 GB of images and backups.
    - In production, set `SIMULATOR_INTERVAL_SECONDS=15` (3× fewer rows).
    - Recommended: grow the volume to 20 GB (EC2 → Volumes → Modify, online), then run `sudo growpart /dev/nvme0n1 1 && sudo xfs_growfs -d /`.

### Step A: base setup (run as-is)
```
ssh ... "sudo dnf install -y docker git && sudo systemctl enable --now docker && sudo usermod -aG docker ec2-user  && sudo mkdir -p /usr/local/lib/docker/cli-plugins  && sudo curl -fsSL https://github.com/docker/compose/releases/download/v2.29.7/docker-compose-linux-x86_64 -o /usr/local/lib/docker/cli-plugins/docker-compose  && sudo curl -fsSL https://github.com/docker/buildx/releases/download/v0.17.1/buildx-v0.17.1.linux-amd64 -o /usr/local/lib/docker/cli-plugins/docker-buildx  && sudo chmod +x /usr/local/lib/docker/cli-plugins/*  && (swapon --show | grep -q swapfile || (sudo dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile && echo '/swapfile swap swap defaults 0 0' | sudo tee -a /etc/fstab))  && docker --version && sudo docker compose version && sudo docker buildx version && free -h"
```
