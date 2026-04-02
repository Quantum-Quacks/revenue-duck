# Revenue Duck

Serverless microservice (Vercel) that monitors App Store revenue and sends real-time notifications to Telegram.

## Features

### App Store Server Notifications V2 (`/api/notify`)

Receives Apple's signed JWS notifications (purchases, refunds, subscription events, etc.) and forwards a formatted summary to Telegram.

Supported event types: purchases, subscriptions, renewals, refunds, offer redemptions, price changes, and more.

### Daily Sales Report (`/api/sales-report`)

Cron job (daily at 19:00 UTC) that fetches the previous day's sales report from the App Store Connect API and sends a breakdown to Telegram, grouped by paid apps and in-app purchases.

## Setup

1. Deploy to Vercel
2. Configure environment variables:

| Variable | Description |
|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Telegram bot token |
| `TELEGRAM_CHAT_ID` | Telegram chat/group ID |
| `ASC_API_KEY_ID` | App Store Connect API Key ID |
| `ASC_API_ISSUER_ID` | App Store Connect Issuer ID |
| `ASC_PRIVATE_KEY` | ASC private key (base64-encoded) |
| `ASC_VENDOR_NUMBER` | Your vendor number |
| `CRON_SECRET` | Secret for Vercel Cron auth |

3. Set the `/api/notify` URL as your App Store Server Notifications V2 endpoint in App Store Connect.

## Tech Stack

- Node.js (ES Modules)
- Vercel Serverless Functions
- Vercel Cron Jobs
- App Store Connect API
- Telegram Bot API
