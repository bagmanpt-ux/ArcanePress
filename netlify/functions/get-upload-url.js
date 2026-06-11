/**
 * get-upload-url.js
 * POST /.netlify/functions/get-upload-url
 *
 * Returns a presigned S3 PUT URL so the browser can upload custom card art
 * directly to S3 without routing the file through the function.
 *
 * Required env vars:
 *   AWS_ACCESS_KEY_ID
 *   AWS_SECRET_ACCESS_KEY
 *   AWS_REGION             – e.g. "eu-west-2"
 *   S3_BUCKET              – bucket name, e.g. "arcanepress-uploads"
 */

const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const crypto = require('crypto');
const path = require('path');

const s3 = new S3Client({ region: process.env.AW_REGION });

// Allowed image MIME types
const ALLOWED_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);

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

  const { filename, contentType } = payload;

  if (!filename || !contentType) {
    return { statusCode: 400, body: 'filename and contentType are required' };
  }

  if (!ALLOWED_TYPES.has(contentType)) {
    return { statusCode: 400, body: 'Only image files are accepted' };
  }

  // Build a unique S3 key: uploads/YYYY-MM-DD/<uuid>-<sanitised-filename>
  const date = new Date().toISOString().slice(0, 10);
  const uid = crypto.randomBytes(8).toString('hex');
  const safeName = path
    .basename(filename)
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 100);
  const key = `uploads/${date}/${uid}-${safeName}`;

  let uploadUrl;
  try {
    const command = new PutObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: key,
      ContentType: contentType,
      // Prevent public access — only readable by your backend
      ACL: 'private',
    });
    // URL expires in 10 minutes
    uploadUrl = await getSignedUrl(s3, command, { expiresIn: 600 });
  } catch (err) {
    console.error('S3 presign error:', err);
    return { statusCode: 500, body: 'Could not generate upload URL: ' + err.message };
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uploadUrl, key }),
  };
};
