# ArcanePress – Setup & Deployment Guide

## What's in this project

```
arcanepress/
├── public/
│   └── index.html              ← Your frontend (rename mtg-proxy-shop.html → index.html)
├── netlify/
│   └── functions/
│       ├── create-order.js     ← Saves order to DynamoDB, creates PayPal order
│       ├── capture-payment.js  ← Captures PayPal payment, marks order paid
│       └── get-upload-url.js   ← Issues presigned S3 URL for custom art uploads
├── package.json
├── netlify.toml
└── SETUP.md                    ← This file
```

---

## Step 1 — PayPal REST App

1. Log in to https://developer.paypal.com
2. Go to **My Apps & Credentials**
3. Create a new app under the **REST API apps** section
4. Copy your **Client ID** and **Client Secret** (use Sandbox for testing, Live for production)
5. In `public/index.html`, replace `YOUR_PAYPAL_CLIENT_ID` in the `<script>` tag:
   ```html
   <script src="https://www.paypal.com/sdk/js?client-id=Ab7de-772fKseVGRrachmxOy3MYinOfp7WxO5Z5DPdD1Qe0pMILFiqhNMnM_vO3rsvZR-zDaZYPpqXQY&currency=GBP&intent=capture">
   ```

---

## Step 2 — AWS: IAM User

1. Log in to https://console.aws.amazon.com
2. Go to **IAM → Users → Create user**
3. Name it `arcanepress-backend`, choose **Programmatic access**
4. Attach the following inline policy (replace `YOUR_REGION` and `YOUR_ACCOUNT_ID`):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "dynamodb:PutItem",
        "dynamodb:UpdateItem",
        "dynamodb:GetItem",
        "dynamodb:Query"
      ],
      "Resource": "arn:aws:dynamodb:eu-west-2:379611523217:table/arcanepress-orders"
    },
    {
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:GetObject"
      ],
      "Resource": "arn:aws:s3:::arcanepress-uploads/*"
    }
  ]
}
```

5. Save the **Access Key ID** and **Secret Access Key** — you'll need them in Step 5.

---

## Step 3 — AWS: DynamoDB Table

1. Go to **DynamoDB → Tables → Create table**
2. Table name: `arcanepress-orders`
3. Partition key: `orderId` (String)
4. Leave all other settings as default (On-demand billing recommended for low traffic)
5. Click **Create table**

---

## Step 4 — AWS: S3 Bucket

1. Go to **S3 → Create bucket**
2. Bucket name: `arcanepress-uploads` (must be globally unique — add a suffix if taken)
3. Region: same as your DynamoDB table
4. **Block all public access**: keep enabled (files upload via presigned URLs, never public)
5. Enable **Server-side encryption** (SSE-S3 is fine)
6. Click **Create bucket**

Add a lifecycle rule to auto-delete uploads after 90 days (optional but recommended):
- Go to bucket → **Management → Lifecycle rules → Create rule**
- Rule name: `expire-uploads`, apply to prefix `uploads/`
- Action: **Expire current versions** after 90 days

---

## Step 5 — Netlify: Deploy

### First deploy

1. Push this entire folder to a GitHub/GitLab repository
2. Log in to https://app.netlify.com → **Add new site → Import an existing project**
3. Connect your repo, set:
   - **Publish directory**: `public`
   - **Functions directory**: `netlify/functions`
4. Click **Deploy site**

### Environment variables

In Netlify dashboard → **Site settings → Environment variables**, add:

| Variable | Value |
|---|---|
| `PAYPAL_CLIENT_ID` | From Step 1 |
| `PAYPAL_CLIENT_SECRET` | From Step 1 |
| `PAYPAL_ENV` | `sandbox` (change to `live` for production) |
| `AWS_ACCESS_KEY_ID` | From Step 2 |
| `AWS_SECRET_ACCESS_KEY` | From Step 2 |
| `AWS_REGION` | e.g. `eu-west-2` |
| `DYNAMO_TABLE` | `arcanepress-orders` |
| `S3_BUCKET` | `arcanepress-uploads` (or your chosen name) |

After adding variables, trigger a **redeploy** (Deploys → Trigger deploy).

---

## Step 6 — Test in sandbox

1. With `PAYPAL_ENV=sandbox`, use a PayPal sandbox buyer account to place a test order
2. Check **DynamoDB → arcanepress-orders** for a new row with `status: "paid"`
3. Check **S3 → arcanepress-uploads** for any custom art files
4. Once confirmed working, update `PAYPAL_ENV` to `live` and redeploy

---

## Order data structure (DynamoDB)

Each order record contains:

| Field | Type | Description |
|---|---|---|
| `orderId` | String (PK) | e.g. `AP-3F9A2C1B` |
| `createdAt` | String | ISO 8601 timestamp |
| `status` | String | `pending_payment` → `paid` |
| `totalGBP` | String | e.g. `"6.60"` |
| `cardCount` | Number | Total cards ordered |
| `items` | String (JSON) | Array of cart items |
| `shipping` | String (JSON) | Buyer's address & email |
| `customFileKeys` | String (JSON) | Array of S3 keys for uploaded art |
| `paypalOrderId` | String | PayPal order ID |
| `paypalCaptureId` | String | PayPal capture ID |
| `paidAt` | String | ISO timestamp of payment capture |

---

## Viewing orders

The quickest way to view orders is in the AWS Console → DynamoDB → arcanepress-orders → **Explore table items**.

For a proper admin dashboard, you can build a separate Netlify Function `list-orders.js` using `ScanCommand` or `QueryCommand` — protect it with a secret header or Netlify Identity.

---

## Pricing

Price per card is set in `public/index.html`:
```js
const PRICE_PER_CARD = 0.55;
```
The backend (`create-order.js`) recalculates the total server-side using the same constant, so the client-side price cannot be tampered with.
