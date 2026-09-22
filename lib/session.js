import crypto from 'node:crypto';

function base64UrlEncode(value) {
  return Buffer.from(value).toString('base64url');
}

function base64UrlDecode(value) {
  return Buffer.from(value, 'base64url').toString('utf8');
}

export function createSessionToken(user, secret, expiresInMs = 1000 * 60 * 60 * 8) {
  if (!user || !user.id || !secret) {
    throw new Error('Session user and secret are required');
  }

  const payload = {
    id: user.id,
    email: user.email,
    exp: Date.now() + expiresInMs,
  };

  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signature = crypto.createHmac('sha256', secret).update(encodedPayload).digest('base64url');
  return `${encodedPayload}.${signature}`;
}

export function verifySessionToken(token, secret) {
  if (!token || !secret) return null;
  const [encodedPayload, signature] = String(token).split('.');
  if (!encodedPayload || !signature) return null;

  const expectedSignature = crypto.createHmac('sha256', secret).update(encodedPayload).digest('base64url');
  if (expectedSignature.length !== signature.length) return null;
  if (crypto.timingSafeEqual(Buffer.from(expectedSignature), Buffer.from(signature))) {
    try {
      const payload = JSON.parse(base64UrlDecode(encodedPayload));
      if (!payload || !payload.id || !payload.email || Number(payload.exp) < Date.now()) {
        return null;
      }
      return { id: payload.id, email: payload.email };
    } catch {
      return null;
    }
  }

  return null;
}
