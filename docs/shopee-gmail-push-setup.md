# Shopee Gmail push setup

This backend receives Google-authenticated Pub/Sub pushes at:

```text
POST https://sc-official-website.onrender.com/api/shopee-webhooks/gmail
```

The endpoint verifies the Google OIDC signature, exact audience, verified service-account email,
and a pinned Gmail mailbox-to-shop mapping before it acknowledges the notification. It never
accepts OAuth credentials or shared secrets in the URL.

## Fixed production identities

```text
Project ID: disco-outpost-470112-m1
Project number: 67748418977
Push service account:
  pubsub-push-shopee@disco-outpost-470112-m1.iam.gserviceaccount.com
SC Drug Store mailbox: admin@scgroup1989.com
DR.Morepen mailbox: scgroup1989.glucooneshop@gmail.com
```

The keyless push service account must remain keyless. Pub/Sub mints short-lived OIDC tokens for
it; no JSON key is required.

## 1. Google Cloud topic permissions

The SC Drug Store topic already exists:

```text
projects/disco-outpost-470112-m1/topics/gmail-admin-updates
```

It must grant `roles/pubsub.publisher` to:

```text
gmail-api-push@system.gserviceaccount.com
```

The Pub/Sub service agent must have `roles/iam.serviceAccountTokenCreator` on the keyless push
service account. This binding is already configured for:

```text
service-67748418977@gcp-sa-pubsub.iam.gserviceaccount.com
```

Create the DR.Morepen topic only after confirming its refresh token uses an OAuth client from
this same Google Cloud project. Gmail requires the topic project to exactly match the developer
project executing `users.watch`.

```bash
PROJECT_ID="disco-outpost-470112-m1"

gcloud pubsub topics create gmail-drmorepen-updates \
  --project="$PROJECT_ID"

gcloud pubsub topics add-iam-policy-binding gmail-drmorepen-updates \
  --project="$PROJECT_ID" \
  --member="serviceAccount:gmail-api-push@system.gserviceaccount.com" \
  --role="roles/pubsub.publisher"
```

## 2. Deploy the webhook before creating subscriptions

Add these environment variables to the Render backend service:

```text
SEAMLESS_SHOPEE_GMAIL_PUSH_AUDIENCE=https://sc-official-website.onrender.com/api/shopee-webhooks/gmail
SEAMLESS_SHOPEE_GMAIL_PUSH_SERVICE_ACCOUNT_EMAIL=pubsub-push-shopee@disco-outpost-470112-m1.iam.gserviceaccount.com
```

Deploy this code and confirm the normal health endpoint still returns HTTP 200:

```text
GET https://sc-official-website.onrender.com/api/health
```

Calling the Shopee webhook manually without a genuine Google ID token should return HTTP 401.
That is the expected fail-closed health check.

## 3. Create authenticated push subscriptions

Run in Cloud Shell after the endpoint is deployed:

```bash
PROJECT_ID="disco-outpost-470112-m1"
ENDPOINT="https://sc-official-website.onrender.com/api/shopee-webhooks/gmail"
PUSH_ACCOUNT="pubsub-push-shopee@${PROJECT_ID}.iam.gserviceaccount.com"

gcloud pubsub subscriptions create shopee-admin-push \
  --project="$PROJECT_ID" \
  --topic="gmail-admin-updates" \
  --push-endpoint="$ENDPOINT" \
  --push-auth-service-account="$PUSH_ACCOUNT" \
  --push-auth-token-audience="$ENDPOINT" \
  --ack-deadline="30" \
  --min-retry-delay="10s" \
  --max-retry-delay="600s"
```

After the DR.Morepen topic is ready:

```bash
gcloud pubsub subscriptions create shopee-drmorepen-push \
  --project="$PROJECT_ID" \
  --topic="gmail-drmorepen-updates" \
  --push-endpoint="$ENDPOINT" \
  --push-auth-service-account="$PUSH_ACCOUNT" \
  --push-auth-token-audience="$ENDPOINT" \
  --ack-deadline="30" \
  --min-retry-delay="10s" \
  --max-retry-delay="600s"
```

The account creating or modifying either subscription needs `iam.serviceAccounts.actAs` on
`$PUSH_ACCOUNT`. If Cloud Shell reports that specific missing permission, grant the current
Google user `roles/iam.serviceAccountUser` on this service account only, then retry:

```bash
CURRENT_USER="$(gcloud config get-value account)"

gcloud iam service-accounts add-iam-policy-binding "$PUSH_ACCOUNT" \
  --project="$PROJECT_ID" \
  --member="user:${CURRENT_USER}" \
  --role="roles/iam.serviceAccountUser"
```

## 4. Configure daily Gmail watch renewal

Add these GitHub Actions secrets. Use the existing read-only OAuth values; do not paste them into
source files or workflow YAML.

```text
SEAMLESS_PHARMCARE_GMAIL_AUTH_MODE
SEAMLESS_PHARMCARE_GMAIL_CLIENT_ID
SEAMLESS_PHARMCARE_GMAIL_CLIENT_SECRET
SEAMLESS_PHARMCARE_GMAIL_REFRESH_TOKEN
SEAMLESS_SHOPEE_SC_GMAIL_PUBSUB_TOPIC

SEAMLESS_SHOPEE_DRMOREPEN_GMAIL_AUTH_MODE
SEAMLESS_SHOPEE_DRMOREPEN_GMAIL_CLIENT_ID
SEAMLESS_SHOPEE_DRMOREPEN_GMAIL_CLIENT_SECRET
SEAMLESS_SHOPEE_DRMOREPEN_GMAIL_REFRESH_TOKEN
SEAMLESS_SHOPEE_DRMOREPEN_GMAIL_PUBSUB_TOPIC
```

Topic secret values:

```text
SEAMLESS_SHOPEE_SC_GMAIL_PUBSUB_TOPIC=projects/disco-outpost-470112-m1/topics/gmail-admin-updates
SEAMLESS_SHOPEE_DRMOREPEN_GMAIL_PUBSUB_TOPIC=projects/disco-outpost-470112-m1/topics/gmail-drmorepen-updates
```

Set repository variables to `true` only for mailboxes that are completely configured:

```text
SHOPEE_SC_GMAIL_PUSH_ENABLED=true
SHOPEE_DRMOREPEN_GMAIL_PUSH_ENABLED=true
```

Run **Actions > Renew Shopee Gmail watches > Run workflow** for the selected shop. A successful
job prints the mailbox, topic, history ID, and expiration. Gmail immediately publishes an initial
notification after a successful `watch` call. The scheduled workflow renews daily because a watch
expires within seven days.

For the shared admin mailbox, the SC Drug Store and PharmCare watch jobs must use the same
`gmail-admin-updates` topic. One topic can fan out to multiple subscriptions; do not point later
watch renewals for that mailbox at competing topics.

## 5. Verification and fallback

Check the Render logs for:

```text
shopee_gmail_push_sync_complete
```

Then reload `/shopee/orders` and confirm `lastEventAt` advances after a new Shopee email arrives.
Keep `.github/workflows/shopee-order-sync.yml` enabled as a low-frequency recovery path because
Gmail documents that notifications can occasionally be delayed or dropped. Database upserts and
per-shop locks keep both push and cron execution idempotent.

Official references:

- https://developers.google.com/workspace/gmail/api/guides/push
- https://developers.google.com/workspace/gmail/api/reference/rest/v1/users/watch
- https://docs.cloud.google.com/pubsub/docs/authenticate-push-subscriptions
- https://docs.cloud.google.com/sdk/gcloud/reference/pubsub/subscriptions/create
