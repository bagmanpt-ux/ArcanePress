/**
 * create-order.js
 * POST /.netlify/functions/create-order
 *
 * 1. Saves the order (pending) to DynamoDB
 * 2. Creates a PayPal order via PayPal Orders API v2
 * 3. Returns { paypalOrderId, internalOrderId } to the frontend
 *
 * Required env vars (set in Netlify dashboard → Site settings → Environment variables):
 *   PAYPAL_CLIENT_ID       – PayPal REST app client ID
 *   PAYPAL_CLIENT_SECRET   – PayPal REST app client secret
 *   PAYPAL_ENV             – "sandbox" or "live"
 *   AWS_ACCESS_KEY_ID      – IAM user with DynamoDB + S3 access
 *   AWS_SECRET_ACCESS_KEY
 *   AWS_REGION             – e.g. "eu-west-2"
 *   DYNAMO_TABLE           – DynamoDB table name, e.g. "arcanepress-orders"
 */

const { DynamoDBClient, PutItemCommand } = require('@aws-sdk/client-dynamodb');
const { marshall } = require('@aws-sdk/util-dynamodb');
const https = require('https');
const crypto = require('crypto');

const dynamo = new DynamoDBClient({ region: process.env.AWS_REGION });

// ── PayPal helpers ────────────────────────────────────────────────────────────
const PAYPAL_BASE =
  process.env.PAYPAL_ENV === 'live'
    ? 'https://api-m.paypal.com'
    : 'https://api-m.sandbox.paypal.com';

async function getPayPalToken() {
  const creds = Buffer.from(
    `${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`
  ).toString('base64');

  const body = 'grant_type=client_credentials';
  return new Promise((resolve, reject) => {
    const req = https.request(
      `${PAYPAL_BASE}/v1/oauth2/token`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${creds}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          const json = JSON.parse(data);
          if (json.access_token) resolve(json.access_token);
          else reject(new Error('PayPal token error: ' + data));
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function createPayPalOrder(token, amountGBP, internalOrderId) {
  const body = JSON.stringify({
    intent: 'CAPTURE',
    purchase_units: [
      {
        reference_id: internalOrderId,
        description: 'ArcanePress MTG Proxy Cards',
        amount: {
          currency_code: 'GBP',
          value: amountGBP,
        },
      },
    ],
    application_context: {
      brand_name: 'ArcanePress',
      user_action: 'PAY_NOW',
    },
  });

  return new Promise((resolve, reject) => {
    const req = https.request(
      `${PAYPAL_BASE}/v2/checkout/orders`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          const json = JSON.parse(data);
          if (json.id) resolve(json.id);
          else reject(new Error('PayPal order error: ' + data));
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Handler ───────────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  const { items, shipping, customFileKeys = [], totalGBP } = payload;

  if (!items?.length || !shipping?.email || !totalGBP) {
    return { statusCode: 400, body: 'Missing required fields' };
  }

  // Recalculate total server-side to prevent tampering
  const PRICE = 0.55;
  const cardCount = items.reduce((s, i) => s + (i.qty || 1), 0);
  const computedTotal = (cardCount * PRICE).toFixed(2);

  const internalOrderId = 'AP-' + crypto.randomBytes(6).toString('hex').toUpperCase();
  const createdAt = new Date().toISOString();

  // Save to DynamoDB
  try {
    await dynamo.send(
      new PutItemCommand({
        TableName: process.env.DYNAMO_TABLE,
        Item: marshall({
          orderId: internalOrderId,
          createdAt,
          status: 'pending_payment',
          totalGBP: computedTotal,
          cardCount,
          items: JSON.stringify(items),
          shipping: JSON.stringify(shipping),
          customFileKeys: JSON.stringify(customFileKeys),
          paypalOrderId: '',   // filled in by capture-payment
        }),
      })
    );
  } catch (err) {
    console.error('DynamoDB error:', err);
    return { statusCode: 500, body: 'Failed to save order: ' + err.message };
  }

  // Create PayPal order
  let paypalOrderId;
  try {
    const token = await getPayPalToken();
    paypalOrderId = await createPayPalOrder(token, computedTotal, internalOrderId);
  } catch (err) {
    console.error('PayPal error:', err);
    return { statusCode: 502, body: 'PayPal error: ' + err.message };
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paypalOrderId, internalOrderId }),
  };
};
