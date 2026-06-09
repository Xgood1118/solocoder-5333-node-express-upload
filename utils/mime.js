const config = require('../config');

const MAGIC_NUMBERS = [
  { mime: 'image/png', magic: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A] },
  { mime: 'image/jpeg', magic: [0xFF, 0xD8, 0xFF] },
  { mime: 'image/gif', magic: [0x47, 0x49, 0x46, 0x38] },
  { mime: 'image/webp', magic: [0x52, 0x49, 0x46, 0x46], offset: 0, skip: 4, suffix: [0x57, 0x45, 0x42, 0x50] },
  { mime: 'application/pdf', magic: [0x25, 0x50, 0x44, 0x46] },
  { mime: 'application/zip', magic: [0x50, 0x4B, 0x03, 0x04] },
  { mime: 'video/mp4', magic: [0x00, 0x00, 0x00], skip: 3, suffix: [0x66, 0x74, 0x79, 0x70] },
  { mime: 'video/webm', magic: [0x1A, 0x45, 0xDF, 0xA3] },
  { mime: 'audio/mpeg', magic: [0xFF, 0xFB] },
  { mime: 'audio/mpeg', magic: [0x49, 0x44, 0x33] },
  { mime: 'audio/wav', magic: [0x52, 0x49, 0x46, 0x46], skip: 4, suffix: [0x57, 0x41, 0x56, 0x45] },
  { mime: 'audio/ogg', magic: [0x4F, 0x67, 0x67, 0x53] },
  { mime: 'application/msword', magic: [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1] },
  { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', magic: [0x50, 0x4B, 0x03, 0x04] },
  { mime: 'application/vnd.ms-excel', magic: [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1] },
  { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', magic: [0x50, 0x4B, 0x03, 0x04] },
  { mime: 'text/plain', magic: [] }
];

function detectMimeFromBuffer(buffer) {
  if (!buffer || buffer.length === 0) return null;

  for (const entry of MAGIC_NUMBERS) {
    if (matchesMagic(buffer, entry)) {
      if (entry.mime === 'application/zip') {
        if (looksLikeOfficeOpenXML(buffer)) {
          return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
        }
      }
      return entry.mime;
    }
  }

  return null;
}

function matchesMagic(buffer, entry) {
  const magic = entry.magic;
  if (magic.length === 0) return false;
  if (buffer.length < magic.length) return false;

  for (let i = 0; i < magic.length; i++) {
    if (buffer[i] !== magic[i]) return false;
  }

  if (entry.suffix) {
    const offset = entry.skip || 0;
    const suffixStart = magic.length + offset;
    if (buffer.length < suffixStart + entry.suffix.length) return false;
    for (let i = 0; i < entry.suffix.length; i++) {
      if (buffer[suffixStart + i] !== entry.suffix[i]) return false;
    }
  }

  return true;
}

function looksLikeOfficeOpenXML(buffer) {
  const str = buffer.toString('utf8', 0, Math.min(buffer.length, 100));
  return str.includes('[Content_Types].xml') || str.includes('word/') || str.includes('xl/');
}

function validateMimeType(mime) {
  return config.allowedMimeTypes.includes(mime);
}

function getExtensionFromMime(mime) {
  const extMap = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'application/pdf': '.pdf',
    'text/plain': '.txt',
    'application/zip': '.zip',
    'application/msword': '.doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
    'application/vnd.ms-excel': '.xls',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
    'video/mp4': '.mp4',
    'video/webm': '.webm',
    'audio/mpeg': '.mp3',
    'audio/wav': '.wav',
    'audio/ogg': '.ogg'
  };
  return extMap[mime] || '';
}

module.exports = {
  detectMimeFromBuffer,
  validateMimeType,
  getExtensionFromMime
};
