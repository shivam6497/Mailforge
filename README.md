# Mailforge

> Email infrastructure built from scratch — DKIM signing, domain verification, multi-tenant API key auth. No Resend. No SendGrid. Raw AWS SES API.

Built this to understand how email infrastructure actually works under the hood. Most developers treat email as a black box — call an SDK, email arrives. This project breaks open that box.

---

## What this is

Mailforge is a self-hosted email sending API. You add your domain, add DNS records, and send emails via a REST API using an API key. Emails are cryptographically signed with DKIM so receiving servers (Gmail, Outlook) can verify they actually came from your domain.

It is not a production SaaS. It is a deep-dive into the infrastructure layer that services like Resend and SendGrid are built on.

---

## Architecture

```
Client
  │
  ▼
POST /api/emails
  │
  ├── requireApiKey middleware       (validates key, extracts userId + keyId)
  ├── rateLimitByApiKey middleware   (token bucket, 100 req/10s per API key)
  │
  ▼
sendEmail handler
  │
  ├── verify domain is VERIFIED + owned by this user
  ├── create Email row (status: QUEUED)
  ├── enqueue job → email-send queue (BullMQ)
  │
  ▼
Email Send Worker (BullMQ)   ← separate process: apps/worker
  │
  ├── fetch email + domain from DB
  ├── decrypt DKIM private key (AES-256-GCM)
  ├── sign email with DKIM (via nodemailer)
  ├── send via AWS SES SDK (SendRawEmailCommand)
  ├── update status → DELIVERED or FAILED
  │
  ▼
Gmail / Outlook / any receiving server
  │
  └── verifies DKIM signature against DNS TXT record ✓


Domain Verification Flow
─────────────────────────
POST /api/domains
  │
  ├── generate RSA-2048 keypair
  ├── encrypt private key with AES-256-GCM
  ├── store encrypted key + public key in DB
  ├── call SES CreateEmailIdentity (for SES-side verification)
  ├── enqueue job → domain-verify queue
  │
  ▼
Domain Verify Worker (BullMQ)   ← separate process: apps/worker
  │
  ├── retry up to 576 attempts with 5-minute fixed backoff (≈48 hours)
  ├── check _resend-verify.<domain> TXT → ownership
  ├── check resend._domainkey.<domain> TXT → DKIM public key
  ├── check SES GetEmailIdentity → sesVerified
  ├── all three pass → status: VERIFIED
  └── exhausted attempts → status: FAILED
```

---

## How DKIM works

DKIM (DomainKeys Identified Mail) lets you prove that an email was sent by someone who controls the domain it claims to be from. Here's the actual mechanism:

**1. Key generation**

When you add a domain, Mailforge generates an RSA-2048 keypair:

```
Private key  →  stays on the server, used to sign outgoing emails
Public key   →  published in DNS as a TXT record at resend._domainkey.yourdomain.com
```

**2. Private key encryption at rest**

The private key never touches the database in plaintext. Before storing:

```
AES-256-GCM encryption
  key     = DKIM_ENCRYPTION_KEY env var (64-char hex → 32 raw bytes)
  iv      = 12 random bytes (unique per domain)
  output  = base64(iv):base64(authTag):base64(ciphertext)
```

On send, the worker decrypts it in memory, uses it to sign, then discards it. The plaintext key never persists.

**3. Signing outgoing email**

When you call `POST /api/emails`, the worker:

- Takes the email headers (From, To, Subject, Date) + body
- Hashes them with SHA-256
- Signs the hash with the domain's RSA private key
- Attaches the signature as a `DKIM-Signature` header (via nodemailer's DKIM support)

```
DKIM-Signature: v=1; a=rsa-sha256; d=yourdomain.com; s=resend;
  h=from:to:subject:date; bh=<body hash>; b=<signature>
```

**4. Verification by the receiving server**

Gmail receives your email and:

1. Reads `d=yourdomain.com` and `s=resend` from the DKIM-Signature header
2. Fetches the TXT record at `resend._domainkey.yourdomain.com`
3. Extracts the public key from `v=DKIM1; k=rsa; p=<public key>`
4. Uses the public key to verify the signature on the headers + body
5. If it matches → DKIM pass. Email is trusted.

If anyone tampers with the email in transit (changes the From address, modifies the body), the signature breaks and DKIM fails.

**5. Why SPF and SES verification too**

- **SPF** (`v=spf1 include:amazonses.com ~all`) tells receiving servers that AWS SES is authorized to send mail on behalf of your domain. Without it, SES-originated emails look suspicious.
- **SES domain verification** is required by AWS before they'll send email for your domain at all. They give you 3 CNAME records pointing to their own DKIM infrastructure for this verification step.

So the full DNS setup is 6 records: 1 ownership TXT + 1 DKIM TXT + 1 SPF TXT (your app) + 3 CNAME records (SES).

---

## Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js + TypeScript |
| Framework | Express |
| Database | PostgreSQL + Prisma |
| Queue | BullMQ + Redis |
| Email transport | AWS SES (SDK API via nodemailer) |
| DKIM signing | nodemailer built-in DKIM |
| Validation | Zod |
| Monorepo | Turborepo + pnpm workspaces |

**Apps:**
- `apps/httpserver` — Express API (routes, controllers, middleware)
- `apps/worker` — BullMQ workers (email send + domain verification)
- `apps/client` — Frontend (planned)

**Packages:**
- `packages/db` — Prisma schema + client
- `packages/queue` — BullMQ queue names, Redis singleton factory
- `packages/types` — Shared TypeScript types (job payloads)
- `packages/typescript-config` — Shared tsconfig
- `packages/eslint-config` — Shared ESLint config

---

### Auth

Auth uses **HTTP-only cookies** (access token + refresh token). Register or log in first, then cookies are set automatically.

```
POST /auth/register     Create an account (email + password)
POST /auth/login        Log in, receive JWT cookies
POST /auth/refresh      Rotate access token using refresh token
POST /auth/logout       Clear cookies, revoke refresh token
```

### Domains

Requires auth cookies (JWT).

```
POST   /api/domains         Add a domain, get DNS records to configure
GET    /api/domains         List your domains
GET    /api/domains/:id     Get domain + DNS records
DELETE /api/domains/:id     Delete a domain
```

**Add domain response:**
```json
{
  "domain": { "id": "...", "domain": "example.com", "status": "PENDING" },
  "buildRecords": {
    "ownership": { "type": "TXT", "name": "_resend-verify.example.com", "value": "resend-verify=<token>" },
    "dkim":      { "type": "TXT", "name": "resend._domainkey.example.com", "value": "v=DKIM1; k=rsa; p=<pubkey>" },
    "spf":       { "type": "TXT", "name": "example.com", "value": "v=spf1 include:amazonses.com ~all" }
  },
  "sesDkim": [
    { "type": "CNAME", "name": "<token>._domainkey.example.com", "value": "<token>.dkim.amazonses.com" }
  ]
}
```

### Emails

`POST /api/emails` requires `Authorization: Bearer <api_key>`.
`GET /api/emails/:id` accepts either API key or JWT cookie.
`GET /api/emails` requires JWT cookie.

```
POST /api/emails        Send an email
GET  /api/emails        List sent emails (cursor-paginated)
GET  /api/emails/:id    Get email + delivery status
```

**Send email:**
```json
{
  "from": "hello@yourdomain.com",
  "to": ["user@gmail.com"],
  "subject": "Hello",
  "html": "<p>Hello world</p>",
  "text": "Hello world",
  "replyTo": "support@yourdomain.com"
}
```

**Response (`202 Accepted`):**
```json
{
  "id": "clx...",
  "from": "hello@yourdomain.com",
  "to": ["user@gmail.com"],
  "subject": "Hello",
  "status": "QUEUED",
  "createdAt": "2026-09-05T10:00:00.000Z"
}
```

**Email statuses:** `QUEUED` → `SENDING` → `DELIVERED` or `FAILED`

**List emails query params:**
- `cursor` — cursor for pagination
- `limit` — max results (default 20, max 100)
- `status` — filter by status

### API Keys

Requires auth cookies (JWT).

```
POST   /api/keys         Create an API key (raw key shown once, never again)
GET    /api/keys         List active keys
DELETE /api/keys/:id     Revoke a key
```

---

## Rate limiting

`POST /api/emails` is rate limited per API key using a token bucket:

- Capacity: 100 tokens
- Refill: 10 tokens/second
- Exceeding the limit returns `429 Too Many Requests`

> **Note:** The current implementation uses non-atomic Redis operations (hgetall → compute → hset). A production system should use a Lua script for atomicity.

---

## Setup

### Prerequisites

- Node.js 18+
- pnpm
- PostgreSQL
- Redis
- AWS account with SES access

### AWS SES setup

1. Go to AWS SES → request production access (sandbox only allows verified recipients)
2. Create IAM credentials with SES permissions (`ses:SendRawEmail`, `ses:CreateEmailIdentity`, `ses:GetEmailIdentity`)
3. Note your AWS region (e.g. `ap-south-1`)

### Environment variables

```env
DATABASE_URL=postgresql://user:password@localhost:5432/mailforge
REDIS_URL=redis://localhost:6379

AWS_REGION=ap-south-1
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=

DKIM_ENCRYPTION_KEY=<64-char-hex-string-for-aes-256>
JWT_ACCESS_SECRET=<your-access-token-secret>
JWT_REFRESH_SECRET=<your-refresh-token-secret>

PORT=3001
```

Generate a `DKIM_ENCRYPTION_KEY` with:
```bash
openssl rand -hex 32
```

### Run locally

```bash
# install dependencies
pnpm install

# generate Prisma client
pnpm --filter @resend-clone/db db:generate

# run migrations
pnpm --filter @resend-clone/db db:migrate

# start dev (all apps via turborepo)
pnpm dev
```

---

## What I learned

- How DKIM signing actually works at the cryptographic level — RSA keypairs, SHA-256 hashing, signature verification
- Why private keys need to be encrypted at rest and how AES-256-GCM works (IV + auth tag + ciphertext)
- How DNS-based domain verification works — polling with fixed backoff, why TTL matters
- The difference between your own DKIM signing and SES's own verification flow, and why you need both
- Token bucket rate limiting — why a production implementation needs atomic Redis operations (Lua scripts) to be race-safe
- BullMQ retry patterns — exponential backoff for transient failures (email send), fixed delay for polling workers (domain verify)
- How multi-tenant API key auth works (Stripe's prefix + bcrypt hash pattern)
- JWT cookie-based auth with refresh token rotation and Redis-backed revocation