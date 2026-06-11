/**
 * capture-payment.js
 * POST /.netlify/functions/capture-payment
 *
 * Called after the buyer approves payment in the PayPal button.
 * 1. Captures the PayPal order
 * 2. Updates the DynamoDB record to status "paid"
 *
 * Required env vars: same as create-order.js
 */

const { DynamoDBClient, UpdateItemCommand } = require('@aws-sdk/client-dynamodb');
const { marshall } = require('@aws-sdk/util-dynamodb');
const https = require('https');

const dynamo = new DynamoDBClient({ region: process.env.AWS_REGION });

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

async function capturePayPalOrder(token, paypalOrderId) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      `${PAYPAL_BASE}/v2/checkout/orders/${paypalOrderId}/capture`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Content-Length': 0,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          const json = JSON.parse(data);
          // status COMPLETED means money collected
          if (json.status === 'COMPLETED') resolve(json);
          else reject(new Error('Capture not COMPLETED: ' + data));
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

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

  const { paypalOrderId, internalOrderId } = payload;
  if (!paypalOrderId || !internalOrderId) {
    return { statusCode: 400, body: 'Missing paypalOrderId or internalOrderId' };
  }

  // Capture payment with PayPal
  let captureResult;
  try {
    const token = await getPayPalToken();
    captureResult = await capturePayPalOrder(token, paypalOrderId);
  } catch (err) {
    console.error('PayPal capture error:', err);
    return { statusCode: 502, body: 'PayPal capture failed: ' + err.message };
  }

  const captureId =
    captureResult.purchase_units?.[0]?.payments?.captures?.[0]?.id || paypalOrderId;

  // Update DynamoDB order status to "paid"
  try {
    await dynamo.send(
      new UpdateItemCommand({
        TableName: process.env.DYNAMO_TABLE,
        Key: marshall({ orderId: internalOrderId }),
        UpdateExpression:
          'SET #s = :s, paypalOrderId = :ppid, paypalCaptureId = :capid, paidAt = :ts',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: marshall({
          ':s': 'paid',
          ':ppid': paypalOrderId,
          ':capid': captureId,
          ':ts': new Date().toISOString(),
        }),
      })
    );
  } catch (err) {
    // Payment captured but DB update failed — log it, don't fail the response
    console.error('DynamoDB update error after capture:', err);
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ success: true, internalOrderId, captureId }),
  };
};
