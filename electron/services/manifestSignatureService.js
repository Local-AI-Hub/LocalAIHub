const crypto = require('crypto');
const path = require('path');

const MANIFEST_SIGNATURE_ALGORITHM = 'ed25519';
const MANIFEST_SIGNING_KEY_ID = 'localaihub-tools-manifest-v1';
const MANIFEST_SIGNING_PUBLIC_KEY = [
  '-----BEGIN PUBLIC KEY-----',
  'MCowBQYDK2VwAyEAhZnP8RctTdRUxm+1oIPy4+5uus5BoUqmmP9OusvPF4U=',
  '-----END PUBLIC KEY-----',
  '',
].join('\n');

function canonicalizeManifestPayload(rawText) {
  const parsed = JSON.parse(String(rawText || ''));
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

function computeManifestDigest(rawText) {
  return crypto
    .createHash('sha256')
    .update(canonicalizeManifestPayload(rawText), 'utf8')
    .digest('hex');
}

function getDefaultManifestSignaturePath(manifestPath) {
  return `${manifestPath}.sig`;
}

function getDefaultSigningPrivateKeyPath() {
  return path.join(
    process.env.LOCALAIHUB_MANIFEST_PRIVATE_KEY_DIR || process.env.LOCALAPPDATA || process.env.USERPROFILE || '',
    process.env.LOCALAIHUB_MANIFEST_PRIVATE_KEY_DIR ? '' : 'LocalAIHubSigning',
    process.env.LOCALAIHUB_MANIFEST_PRIVATE_KEY_FILE || 'tools-manifest-signing.private.pem',
  );
}

function normalizeSignatureEnvelope(signatureInput) {
  if (signatureInput && typeof signatureInput === 'object' && !Buffer.isBuffer(signatureInput)) {
    return {
      algorithm: String(signatureInput.algorithm || '').trim(),
      keyId: String(signatureInput.keyId || '').trim(),
      signature: String(signatureInput.signature || '').trim(),
    };
  }

  const parsed = JSON.parse(String(signatureInput || ''));
  return normalizeSignatureEnvelope(parsed);
}

function formatSignatureEnvelope(envelope) {
  return `${JSON.stringify(normalizeSignatureEnvelope(envelope), null, 2)}\n`;
}

function createManifestSignatureEnvelope(rawText, privateKeyPem) {
  const canonicalPayload = canonicalizeManifestPayload(rawText);
  const signature = crypto.sign(null, Buffer.from(canonicalPayload, 'utf8'), privateKeyPem).toString('base64');

  return {
    algorithm: MANIFEST_SIGNATURE_ALGORITHM,
    keyId: MANIFEST_SIGNING_KEY_ID,
    signature,
  };
}

function verifyManifestSignature(rawText, signatureInput, publicKeyPem = MANIFEST_SIGNING_PUBLIC_KEY) {
  const envelope = normalizeSignatureEnvelope(signatureInput);
  if (
    envelope.algorithm !== MANIFEST_SIGNATURE_ALGORITHM ||
    envelope.keyId !== MANIFEST_SIGNING_KEY_ID ||
    !envelope.signature
  ) {
    return false;
  }

  const canonicalPayload = canonicalizeManifestPayload(rawText);
  return crypto.verify(
    null,
    Buffer.from(canonicalPayload, 'utf8'),
    publicKeyPem,
    Buffer.from(envelope.signature, 'base64'),
  );
}

module.exports = {
  MANIFEST_SIGNATURE_ALGORITHM,
  MANIFEST_SIGNING_KEY_ID,
  MANIFEST_SIGNING_PUBLIC_KEY,
  canonicalizeManifestPayload,
  computeManifestDigest,
  createManifestSignatureEnvelope,
  formatSignatureEnvelope,
  getDefaultManifestSignaturePath,
  getDefaultSigningPrivateKeyPath,
  normalizeSignatureEnvelope,
  verifyManifestSignature,
};
