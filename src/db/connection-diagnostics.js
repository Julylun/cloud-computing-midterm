import { MongoNetworkError, MongoServerSelectionError } from 'mongodb';

const PRIORITY = Object.freeze([
  'AUTHENTICATION',
  'AUTHORIZATION',
  'ATLAS_REJECTED',
  'DNS',
  'TLS_ALERT',
  'TLS_CERTIFICATE',
  'NETWORK',
]);

const CERTIFICATE_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'CERT_REVOKED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'ERR_TLS_CERT_SIGNATURE_ALGORITHM_UNSUPPORTED',
]);

const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENETDOWN',
  'EPIPE',
]);

function categoryOf(error) {
  if (error.code === 18) return 'AUTHENTICATION';
  if (error.code === 13) return 'AUTHORIZATION';
  if (error.code === 8000) return 'ATLAS_REJECTED';
  if (error.code === 'ENOTFOUND' || error.code === 'EAI_AGAIN') return 'DNS';
  const dnsQuery = (typeof error.syscall === 'string' && /^query(?:Srv|Txt)$/i.test(error.syscall))
    || (typeof error.message === 'string' && /\bquery(?:Srv|Txt)\b/i.test(error.message));
  if (error.code === 'ECONNREFUSED' && dnsQuery) return 'DNS';
  if (error.code === 'ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR') return 'TLS_ALERT';
  if (CERTIFICATE_CODES.has(error.code)) return 'TLS_CERTIFICATE';
  if (NETWORK_CODES.has(error.code)
    || error instanceof MongoNetworkError
    || error instanceof MongoServerSelectionError) return 'NETWORK';
  return undefined;
}

// Return only a fixed category; driver messages, hosts and credentials stay private.
export function connectionFailureCategory(error) {
  const queue = [];
  const seen = new Set();
  const categories = new Set();
  const enqueue = (value) => {
    if (!value || typeof value !== 'object' || seen.has(value) || queue.length >= 32) return;
    seen.add(value);
    queue.push(value);
  };
  enqueue(error);
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    const category = categoryOf(current);
    if (category) categories.add(category);
    enqueue(current.cause);
    enqueue(current.reason?.error);
    if (current.reason?.servers instanceof Map) {
      for (const server of current.reason.servers.values()) {
        if (queue.length >= 32) break;
        enqueue(server?.error);
      }
    }
  }
  return PRIORITY.find((category) => categories.has(category)) || 'UNKNOWN';
}
