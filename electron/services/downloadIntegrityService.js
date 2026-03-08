const crypto = require('crypto');
const fs = require('fs-extra');

const { version: APP_VERSION } = require('../../package.json');

const { assertSecureRemoteUrl } = require('./pathSafetyService');

const CHECKSUM_ASSET_NAME_PATTERN = /(sha256|checksums?|sha256sums?)/i;

function parseGitHubReleaseAssetUrl(downloadUrl) {
  try {
    const parsed = new URL(assertSecureRemoteUrl(downloadUrl, 'download URL'));
    if (parsed.hostname.toLowerCase() !== 'github.com') {
      return null;
    }

    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parts.length < 6 || parts[2] !== 'releases') {
      return null;
    }

    if (parts[3] === 'latest' && parts[4] === 'download') {
      return {
        assetName: parts.slice(5).join('/'),
        owner: parts[0],
        repo: parts[1],
        tag: 'latest',
      };
    }

    if (parts[3] === 'download') {
      return {
        assetName: parts.slice(5).join('/'),
        owner: parts[0],
        repo: parts[1],
        tag: parts[4],
      };
    }
  } catch {
    return null;
  }

  return null;
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseSha256FromText(text, assetName) {
  const safeAssetName = escapeRegExp(assetName);
  const patterns = [
    new RegExp(`\\b([a-fA-F0-9]{64})\\b\\s+[* ]?${safeAssetName}\\b`, 'i'),
    new RegExp(`^${safeAssetName}\\s+([a-fA-F0-9]{64})$`, 'im'),
    new RegExp(`SHA256\\s*\\(${safeAssetName}\\)\\s*=\\s*([a-fA-F0-9]{64})`, 'i'),
  ];

  for (const pattern of patterns) {
    const match = String(text || '').match(pattern);
    if (match?.[1]) {
      return match[1].toLowerCase();
    }
  }

  return '';
}

async function fetchGitHubRelease(downloadInfo) {
  const endpoint =
    downloadInfo.tag === 'latest'
      ? `https://api.github.com/repos/${downloadInfo.owner}/${downloadInfo.repo}/releases/latest`
      : `https://api.github.com/repos/${downloadInfo.owner}/${downloadInfo.repo}/releases/tags/${encodeURIComponent(downloadInfo.tag)}`;

  const response = await fetch(endpoint, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': `LocalAIHub/${APP_VERSION}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });

  if (!response.ok) {
    throw new Error('Local AI Hub could not load the official release metadata needed to verify this download.');
  }

  return response.json();
}

async function readChecksumAsset(asset) {
  const response = await fetch(assertSecureRemoteUrl(asset.browser_download_url, 'checksum URL'), {
    headers: {
      'User-Agent': `LocalAIHub/${APP_VERSION}`,
    },
  });

  if (!response.ok) {
    throw new Error('Local AI Hub could not download the official checksum file for this installer.');
  }

  return response.text();
}

async function resolveExpectedSha256(downloadUrl, logger) {
  const downloadInfo = parseGitHubReleaseAssetUrl(downloadUrl);
  if (!downloadInfo) {
    return null;
  }

  const release = await fetchGitHubRelease(downloadInfo);
  const checksumAsset = (release.assets || []).find((asset) =>
    CHECKSUM_ASSET_NAME_PATTERN.test(asset.name || ''),
  );

  if (!checksumAsset) {
    await logger.info('No official checksum asset was published for this release asset.', {
      downloadUrl,
    });
    return null;
  }

  const checksumText = await readChecksumAsset(checksumAsset);
  const sha256 = parseSha256FromText(checksumText, downloadInfo.assetName);
  if (!sha256) {
    throw new Error('Local AI Hub found the official checksum file, but it did not contain a SHA256 entry for this download.');
  }

  return {
    checksumAsset: checksumAsset.name,
    sha256,
    source: 'github-release-checksum',
  };
}

async function computeFileSha256(filePath) {
  const hash = crypto.createHash('sha256');

  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });

  return hash.digest('hex');
}

async function verifyDownloadedFileIntegrity(downloadUrl, filePath, logger, label = 'download') {
  assertSecureRemoteUrl(downloadUrl, `${label} URL`);

  const verificationPlan = await resolveExpectedSha256(downloadUrl, logger);
  if (!verificationPlan) {
    return {
      skipped: true,
    };
  }

  const actualSha256 = await computeFileSha256(filePath);
  if (actualSha256.toLowerCase() !== verificationPlan.sha256.toLowerCase()) {
    throw new Error(`Local AI Hub blocked ${label} because its SHA256 checksum did not match the official release checksum.`);
  }

  await logger.info('Download integrity verification succeeded.', {
    filePath,
    label,
    sha256: actualSha256,
    source: verificationPlan.source,
  });

  return {
    sha256: actualSha256,
    skipped: false,
    source: verificationPlan.source,
  };
}

module.exports = {
  computeFileSha256,
  verifyDownloadedFileIntegrity,
};
