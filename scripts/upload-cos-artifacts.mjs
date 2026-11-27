import fs from 'node:fs';
import path from 'node:path';
import COS from 'cos-nodejs-sdk-v5';

const [releaseDir, bucket, region, prefix, publicBase, ...fileNames] = process.argv.slice(2);
const secretId = process.env.TENCENT_COS_SECRET_ID;
const secretKey = process.env.TENCENT_COS_SECRET_KEY;

if (!releaseDir || !bucket || !region || prefix === undefined || !publicBase || fileNames.length === 0) {
  throw new Error('Usage: node scripts/upload-cos-artifacts.mjs <release-dir> <bucket> <region> <prefix> <public-base> <file...>');
}
if (!secretId || !secretKey) {
  throw new Error('TENCENT_COS_SECRET_ID and TENCENT_COS_SECRET_KEY are required');
}

const cos = new COS({ SecretId: secretId, SecretKey: secretKey });
const normalizedPrefix = prefix.replace(/^\/+|\/+$/gu, '');
const normalizedPublicBase = publicBase.replace(/\/+$/u, '');

for (const fileName of fileNames) {
  if (path.basename(fileName) !== fileName) {
    throw new Error(`Invalid artifact filename: ${fileName}`);
  }

  const filePath = path.join(releaseDir, fileName);
  const fileStat = fs.statSync(filePath, { throwIfNoEntry: false });
  if (!fileStat?.isFile()) {
    throw new Error(`Artifact is missing: ${filePath}`);
  }
  if (fileStat.size > 5_000_000_000) {
    throw new Error(`${fileName} exceeds COS single-PUT limit; multipart COS actions are not granted`);
  }

  const key = [normalizedPrefix, fileName].filter(Boolean).join('/');
  const contentType = fileName.endsWith('.dmg')
    ? 'application/x-apple-diskimage'
    : fileName.endsWith('.gz')
      ? 'application/gzip'
      : 'application/octet-stream';

  let lastPercent = -1;
  await new Promise((resolve, reject) => {
    cos.uploadFile({
      Bucket: bucket,
      Region: region,
      Key: key,
      FilePath: filePath,
      SliceSize: 5_000_000_000,
      ContentType: contentType,
      CacheControl: 'public, max-age=31536000, immutable',
      ContentDisposition: `attachment; filename="${fileName}"`,
      onProgress(progress) {
        const percent = Math.floor(progress.percent * 100);
        if (percent > lastPercent && (percent === 100 || percent % 10 === 0)) {
          lastPercent = percent;
          process.stdout.write(`    ${fileName}: ${percent}%\n`);
        }
      },
    }, (error) => error ? reject(error) : resolve());
  });

  const publicUrl = `${normalizedPublicBase}/${key.split('/').map(encodeURIComponent).join('/')}`;
  const response = await fetch(publicUrl, { method: 'HEAD' });
  if (!response.ok) {
    throw new Error(`Public download check failed for ${key}: HTTP ${response.status}`);
  }
  const publicSize = Number(response.headers.get('content-length'));
  if (publicSize !== fileStat.size) {
    throw new Error(`Public download size mismatch for ${key}: expected ${fileStat.size}, got ${publicSize}`);
  }

  console.log(`==> uploaded ${bucket}/${key}`);
}
