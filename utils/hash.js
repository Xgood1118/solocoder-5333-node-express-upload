const crypto = require('crypto');
const fs = require('fs');
const config = require('../config');

function computeHashFromBuffer(buffer, algorithm) {
  const hash = crypto.createHash(algorithm || config.hashAlgorithm);
  hash.update(buffer);
  return hash.digest('hex');
}

function computeHashFromStream(stream, algorithm) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash(algorithm || config.hashAlgorithm);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

async function computeHashFromFile(filePath, algorithm) {
  const readStream = fs.createReadStream(filePath);
  return computeHashFromStream(readStream, algorithm);
}

module.exports = {
  computeHashFromBuffer,
  computeHashFromStream,
  computeHashFromFile
};
