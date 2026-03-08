const fs = require('fs');
const path = require('path');
const {
  canonicalizeManifestPayload,
  computeManifestDigest,
  createManifestSignatureEnvelope,
  formatSignatureEnvelope,
  getDefaultManifestSignaturePath,
  getDefaultSigningPrivateKeyPath,
  verifyManifestSignature,
} = require('../electron/services/manifestSignatureService');

function resolveArgument(flagName, args) {
  const index = args.indexOf(flagName);
  if (index < 0 || index === args.length - 1) {
    return '';
  }

  return args[index + 1];
}

function main() {
  const args = process.argv.slice(2);
  const verifyOnly = args.includes('--verify');
  const repoRoot = path.resolve(__dirname, '..');
  const manifestPath = path.resolve(
    resolveArgument('--manifest', args) || path.join(repoRoot, 'electron', 'config', 'tools-manifest.json'),
  );
  const signaturePath = path.resolve(
    resolveArgument('--signature', args) || getDefaultManifestSignaturePath(manifestPath),
  );
  const privateKeyPath = path.resolve(
    resolveArgument('--private-key', args) ||
      process.env.LOCALAIHUB_MANIFEST_PRIVATE_KEY_PATH ||
      getDefaultSigningPrivateKeyPath(),
  );

  const rawManifestText = fs.readFileSync(manifestPath, 'utf8');
  const canonicalManifestText = canonicalizeManifestPayload(rawManifestText);

  if (verifyOnly) {
    const rawSignatureText = fs.readFileSync(signaturePath, 'utf8');
    if (!verifyManifestSignature(canonicalManifestText, rawSignatureText)) {
      throw new Error('Manifest signature verification failed.');
    }

    console.log(`Verified manifest signature for ${manifestPath}`);
    console.log(`Signature file: ${signaturePath}`);
    console.log(`Digest: ${computeManifestDigest(canonicalManifestText)}`);
    return;
  }

  if (!fs.existsSync(privateKeyPath)) {
    throw new Error(
      `Private signing key not found at ${privateKeyPath}. Set LOCALAIHUB_MANIFEST_PRIVATE_KEY_PATH or pass --private-key.`,
    );
  }

  const privateKeyPem = fs.readFileSync(privateKeyPath, 'utf8');
  const signatureEnvelope = createManifestSignatureEnvelope(canonicalManifestText, privateKeyPem);
  const formattedSignature = formatSignatureEnvelope(signatureEnvelope);

  fs.writeFileSync(manifestPath, canonicalManifestText, 'utf8');
  fs.writeFileSync(signaturePath, formattedSignature, 'utf8');

  if (!verifyManifestSignature(canonicalManifestText, formattedSignature)) {
    throw new Error('Manifest was signed, but signature verification failed immediately afterward.');
  }

  console.log(`Signed manifest: ${manifestPath}`);
  console.log(`Signature file: ${signaturePath}`);
  console.log(`Private key: ${privateKeyPath}`);
  console.log(`Digest: ${computeManifestDigest(canonicalManifestText)}`);
}

main();
