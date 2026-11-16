# Deploying NexCRM — Oracle Cloud Always Free (Mumbai)

Target: one Ampere A1 VM, 4 ARM cores / 24 GB RAM / 200 GB storage, **free permanently** — not a
12-month trial. That is a genuinely capable server; the measured 100k-lead workload used a
fraction of it.

Budget: **₹0/month** for hosting. The only unavoidable cost is a domain (~₹800/year).

Work through this top to bottom. Steps marked **⚠** are where people get stuck.

---

## 1. Account and instance

1. Sign up at <https://cloud.oracle.com> — choose **India South (Mumbai)** as your home region.
   **The home region cannot be changed later.** A card is required for identity verification;
   Always Free resources are not charged.
2. After signup, **Upgrade to Pay As You Go** is offered. You do not need it. Always Free works on
   the free account — but note that free-tier A1 capacity is released to paid accounts first,
   which is why you may hit step 3's error.
3. **Compute → Instances → Create instance**
   - Image: **Ubuntu 24.04** (ARM build)
   - Shape: **Ampere A1 Flex** → **4 OCPUs, 24 GB** *(the whole free allowance in one machine)*
   - Add your SSH public key (`cat ~/.ssh/id_ed25519.pub`; generate with `ssh-keygen -t ed25519`
     if you have none)
   - Boot volume: **200 GB**

**⚠ "Out of host capacity"** is common for A1 in popular regions. It is not a configuration
mistake. Options: try a different Availability Domain, retry at a quieter hour, or script a retry.
It usually succeeds within a day or two.

---

## 2. Open the network — both layers

**⚠ This is where most people conclude the server is broken.** Oracle filters traffic in *two*
independent places and you must open both. Opening only the cloud firewall leaves the VM silently
unreachable.

**Layer 1 — cloud firewall (Security List):**
Networking → Virtual Cloud Networks → your VCN → Subnet → Security List → **Add Ingress Rules**:

| Source | Protocol | Dest. port |
|---|---|---|
| 0.0.0.0/0 | TCP | 80 |
| 0.0.0.0/0 | TCP | 443 |

**Layer 2 — the VM's own iptables.** Oracle's Ubuntu images ship with a restrictive `iptables`
ruleset that drops everything except SSH, regardless of your Security List. SSH in and fix it:

```bash
ssh ubuntu@<your-public-ip>

sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save      # without this, the rules vanish on reboot
```

Verify both layers are open before continuing — a missing rule here will look like a Caddy or DNS
failure later and waste an hour.

---

## 3. Server preparation

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y docker.io docker-compose-v2 git
sudo usermod -aG docker ubuntu
exit        # log out and back in for the group change to apply
```

Back in:

```bash
docker run --rm hello-world     # must succeed without sudo
```

**Swap.** 24 GB is ample, but a build spike with no swap triggers the OOM killer, which looks like
a random container death:

```bash
sudo fallocate -l 4G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

---

## 4. DNS — before you start the stack

Point two records at the VM's public IP:

| Type | Name | Value |
|---|---|---|
| A | `app.yourdomain.com` | `<public-ip>` |
| A | `api.yourdomain.com` | `<public-ip>` |

**⚠ Do this first and let it propagate.** Caddy requests certificates on startup; if DNS does not
yet resolve, the request fails — and repeated failures hit Let's Encrypt's rate limit, locking you
out of new certificates for that domain for up to a week.

```bash
dig +short app.yourdomain.com    # must return your IP before step 6
```

---

## 5. Code and configuration

```bash
git clone git@github.com:nexcrm/nexcrm.git ~/nexcrm
cd ~/nexcrm
cp deploy/.env.production.template .env.production
```

Generate secrets **on the server** and paste them in:

```bash
for n in JWT_SECRET HOST_JWT_SECRET CREDENTIALS_KEY POSTGRES_PASSWORD; do
  echo "$n=$(openssl rand -base64 32)"
done
```

Edit `.env.production` and set, at minimum:

```ini
JWT_SECRET=...            # from above — must differ from HOST_JWT_SECRET
HOST_JWT_SECRET=...
CREDENTIALS_KEY=...       # must decode to exactly 32 bytes
POSTGRES_PASSWORD=...

APP_DOMAIN=app.yourdomain.com
API_DOMAIN=api.yourdomain.com
ACME_EMAIL=you@yourdomain.com

APP_URL=https://app.yourdomain.com
VITE_API_URL=https://api.yourdomain.com

DATABASE_URL=postgres://crm_app:crm_app_pw@db:5432/nexcrm
DATABASE_ADMIN_URL=postgres://postgres:<POSTGRES_PASSWORD>@db:5432/nexcrm
DB_MODE=external
```

Then lock the file down and verify the encryption key length:

```bash
chmod 600 .env.production
grep ^CREDENTIALS_KEY= .env.production | cut -d= -f2- | base64 -d | wc -c   # must print 32
```

**About `CREDENTIALS_KEY`:** it encrypts every tenant's stored connector credentials. Losing it
makes them permanently unrecoverable — customers must re-enter every WhatsApp/payment key. Back it
up somewhere outside this server, today.

---

## 6. Launch

```bash
cd ~/nexcrm
docker compose -f deploy/docker-compose.prod.yml --env-file .env.production up -d --build
```

The first build takes 5–10 minutes on ARM. Watch it come up:

```bash
docker compose -f deploy/docker-compose.prod.yml ps
docker compose -f deploy/docker-compose.prod.yml logs -f api
```

Expect `nexcrm api listening` and migrations applying in order. Then:

```bash
curl -s https://api.yourdomain.com/health     # {"ok":true,...}
```

and open `https://app.yourdomain.com` — the padlock should be present, with no warning.

**Create your admin account** (the stack starts with none):

```bash
docker compose -f deploy/docker-compose.prod.yml exec api node dist/scripts/seed.js
```

Sign in at `https://app.yourdomain.com/host/login` and **change that password immediately.**

---

## 7. Backups — same day, not later

```bash
sudo mkdir -p /var/backups/nexcrm && sudo chown ubuntu /var/backups/nexcrm
crontab -e
```

```cron
30 2 * * * cd /home/ubuntu/nexcrm && BACKUP_DIR=/var/backups/nexcrm RETENTION_DAYS=14 \
  docker compose -f deploy/docker-compose.prod.yml --env-file .env.production \
  exec -T db sh -c 'pg_dump -U postgres -Fc nexcrm' > /var/backups/nexcrm/nexcrm-$(date +\%F).dump 2>>/var/backups/nexcrm/backup.log
```

**A backup you have never restored is not a backup.** Run the drill once now, and once a quarter:

```bash
bash deploy/restore-drill.sh /var/backups/nexcrm/nexcrm-$(date +%F).dump
```

**Also copy backups off this machine.** A dump sitting on the server it protects does not survive
the failure it exists for. Any S3-compatible bucket, or `rclone` to Google Drive, is fine — see
`deploy/backup.sh`, which already supports `S3_BUCKET` and GPG encryption.

---

## 8. Monitoring — before the first paying customer

- **UptimeRobot** (free): monitor `https://api.yourdomain.com/health` every 5 minutes, alert by
  email/SMS. Finding out from your customer that you are down is a bad first impression.
- **Sentry** (free tier): set `SENTRY_DSN` once wired. Without it, "it threw an error last Tuesday"
  is unanswerable.

---

## 9. Routine operations

```bash
cd ~/nexcrm
D="docker compose -f deploy/docker-compose.prod.yml --env-file .env.production"

git pull && $D up -d --build     # deploy an update (migrations run automatically)
$D logs -f api                   # tail logs
$D restart api                   # restart one service
$D ps                            # health status
$D down                          # stop everything (data volumes survive)
```

**Rollback:** `git checkout <previous-sha> && $D up -d --build`. Note that database migrations do
**not** roll back — check whether the release added a migration before reverting.

---

## 10. Go-live checklist

- [ ] Both firewall layers open (Security List **and** iptables, saved)
- [ ] HTTPS valid on both domains, no browser warning
- [ ] `CREDENTIALS_KEY` verified at 32 bytes **and backed up off-server**
- [ ] `.env.production` is `chmod 600`, never committed
- [ ] Host admin password changed from the seeded default
- [ ] Backup cron running; **restore drill completed successfully at least once**
- [ ] Backups copied off-server
- [ ] UptimeRobot monitoring `/health`
- [ ] A ₹1 live payment tested end to end
- [ ] Terms, Privacy Policy and DPA published
- [ ] Load test re-run on this hardware (the 1M-lead run has never completed)

---

## When to leave this setup

This single VM comfortably serves your first several customers. Move when:

- **Postgres and the app compete for RAM** → move the database to managed Postgres first; it is
  the hardest component to operate and the most costly to lose.
- **You need zero-downtime deploys** → a second VM behind a load balancer. `WORKER_ONLY` already
  exists precisely so background jobs keep running exactly once as web replicas scale.
- **A customer contractually requires an SLA** → single VM means a reboot is an outage. Be honest
  about that in the contract rather than discovering it together.
