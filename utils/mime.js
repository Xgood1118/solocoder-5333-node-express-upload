const config = require('../config');
const path = require('path');

const MAGIC_NUMBERS = [
  { mime: 'image/png', magic: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A] },
  { mime: 'image/jpeg', magic: [0xFF, 0xD8, 0xFF] },
  { mime: 'image/gif', magic: [0x47, 0x49, 0x46, 0x38] },
  { mime: 'image/webp', magic: [0x52, 0x49, 0x46, 0x46], skip: 4, suffix: [0x57, 0x45, 0x42, 0x50] },
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
  { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', magic: [0x50, 0x4B, 0x03, 0x04] }
];

const DANGEROUS_MAGICS = [
  { name: 'PE executable', magic: [0x4D, 0x5A], description: 'Windows executable (.exe, .dll, .sys, etc.)' },
  { name: 'ELF executable', magic: [0x7F, 0x45, 0x4C, 0x46], description: 'Linux/Unix executable' },
  { name: 'Mach-O executable', magic: [0xFE, 0xED, 0xFA, 0xCE], description: 'macOS executable' },
  { name: 'Mach-O 64-bit', magic: [0xFE, 0xED, 0xFA, 0xCF], description: 'macOS 64-bit executable' },
  { name: 'Java class', magic: [0xCA, 0xFE, 0xBA, 0xBE], description: 'Java bytecode (.class)' },
  { name: 'Android APK', magic: [0x50, 0x4B, 0x03, 0x04], checkZip: true, description: 'Android APK (zip-based)' },
  { name: 'BAT/CMD script', magic: [0x40, 0x65, 0x63, 0x68], description: 'Windows batch script' },
  { name: 'Shell script', magic: [0x23, 0x21], description: 'Unix shell script (#!)' },
  { name: 'PowerShell script', magic: [0x3C, 0x3F, 0x70, 0x68], description: 'PHP/PowerShell script' }
];

const DANGEROUS_EXTENSIONS = new Set([
  '.exe', '.dll', '.sys', '.scr', '.com', '.bat', '.cmd', '.ps1', '.psm1',
  '.vbs', '.vbe', '.js', '.jse', '.wsf', '.wsh', '.msi', '.msp', '.mst',
  '.sh', '.bash', '.zsh', '.ksh', '.csh', '.tcsh', '.py', '.pyc', '.pyo',
  '.pl', '.pm', '.rb', '.php', '.php3', '.php4', '.php5', '.phtml',
  '.asp', '.aspx', '.ashx', '.asmx', '.jsp', '.jspx', '.cfm', '.cfml',
  '.htm', '.html', '.swf', '.fla', '.jar', '.class', '.war', '.ear',
  '.apk', '.ipa', '.dmg', '.iso', '.bin', '.img', '.toast', '.vcd',
  '.reg', '.inf', '.ini', '.cfg', '.conf', '.config',
  '.hta', '.cpl', '.msc', '.msu', '.msp', '.msi',
  '.pif', '.sct', '.wsc', '.wsh', '.wsf', '.ocx'
]);

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.log', '.csv', '.json', '.xml', '.yaml', '.yml',
  '.css', '.scss', '.less',
  '.sql', '.r',
  '.diff', '.patch',
  '.toml'
]);

function looksLikeText(buffer) {
  if (!buffer || buffer.length === 0) return false;

  const sampleSize = Math.min(buffer.length, 8192);
  let nullBytes = 0;
  let controlChars = 0;
  let printableChars = 0;

  for (let i = 0; i < sampleSize; i++) {
    const byte = buffer[i];

    if (byte === 0x00) {
      nullBytes++;
    } else if (byte < 0x20 && byte !== 0x09 && byte !== 0x0A && byte !== 0x0D) {
      controlChars++;
    } else if (byte < 0x7F) {
      printableChars++;
    } else if (byte >= 0xC0) {
      printableChars++;
    }
  }

  if (nullBytes > 0) return false;

  const textRatio = (printableChars + controlChars) / sampleSize;
  return textRatio > 0.95;
}

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

function detectDangerousType(buffer) {
  if (!buffer || buffer.length === 0) return null;

  for (const entry of DANGEROUS_MAGICS) {
    if (matchesDangerousMagic(buffer, entry)) {
      return entry;
    }
  }

  return null;
}

function matchesDangerousMagic(buffer, entry) {
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
  const str = buffer.toString('utf8', 0, Math.min(buffer.length, 200));
  return str.includes('[Content_Types].xml') || str.includes('word/') || str.includes('xl/') || str.includes('ppt/');
}

function validateMimeType(mime) {
  if (!mime) return false;
  return config.allowedMimeTypes.includes(mime);
}

function hasDangerousExtension(fileName) {
  const ext = path.extname(fileName || '').toLowerCase();
  return DANGEROUS_EXTENSIONS.has(ext);
}

function isSafeFile(buffer, fileName, strict = true) {
  const extDangerous = hasDangerousExtension(fileName);
  const dangerousType = detectDangerousType(buffer);

  if (extDangerous || dangerousType) {
    return {
      safe: false,
      reason: extDangerous ? 'dangerous_extension' : 'dangerous_content',
      details: dangerousType ? dangerousType.description : 'Dangerous file extension',
      extension: path.extname(fileName || '').toLowerCase()
    };
  }

  if (strict) {
    const mime = detectMimeFromBuffer(buffer);

    if (mime) {
      if (!validateMimeType(mime)) {
        return {
          safe: false,
          reason: 'mime_not_allowed',
          details: "MIME type '" + mime + "' not in whitelist",
          mimeType: mime,
          extension: path.extname(fileName || '').toLowerCase()
        };
      }

      return {
        safe: true,
        mimeType: mime,
        extension: path.extname(fileName || '').toLowerCase()
      };
    }

    const ext = path.extname(fileName || '').toLowerCase();
    if (TEXT_EXTENSIONS.has(ext) && looksLikeText(buffer)) {
      return {
        safe: true,
        mimeType: 'text/plain',
        extension: ext
      };
    }

    return {
      safe: false,
      reason: 'unknown_type',
      details: 'Unrecognized file type (default deny)',
      extension: ext
    };
  }

  return {
    safe: true,
    mimeType: detectMimeFromBuffer(buffer),
    extension: path.extname(fileName || '').toLowerCase()
  };
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
  detectDangerousType,
  validateMimeType,
  hasDangerousExtension,
  isSafeFile,
  getExtensionFromMime,
  DANGEROUS_EXTENSIONS
};
