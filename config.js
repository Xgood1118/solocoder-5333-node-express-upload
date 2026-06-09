const path = require('path');

const config = {
  port: process.env.PORT || 3001,

  uploadDir: path.join(__dirname, 'uploads'),
  chunkDir: path.join(__dirname, 'chunks'),
  dataDir: path.join(__dirname, 'data'),

  defaultChunkSize: 5 * 1024 * 1024,
  minChunkSize: 1 * 1024 * 1024,
  maxChunkSize: 50 * 1024 * 1024,

  maxConcurrentChunks: 5,

  uploadSessionTTL: 24 * 60 * 60 * 1000,

  cleanupInterval: 60 * 60 * 1000,

  ssePushInterval: 1000,

  roles: {
    normal: {
      maxFileSize: 100 * 1024 * 1024,
      monthlyQuota: 5 * 1024 * 1024 * 1024,
      strictMimeCheck: true
    },
    vip: {
      maxFileSize: 500 * 1024 * 1024,
      monthlyQuota: 50 * 1024 * 1024 * 1024,
      strictMimeCheck: false
    },
    auditor: {
      maxFileSize: 0,
      monthlyQuota: 0,
      strictMimeCheck: false,
      readOnly: true
    }
  },

  rateLimit: {
    ip: {
      maxBytesPerSecond: 10 * 1024 * 1024,
      windowMs: 1000
    },
    filesPerMinute: 10
  },

  allowedMimeTypes: [
    'image/png',
    'image/jpeg',
    'image/webp',
    'image/gif',
    'application/pdf',
    'text/plain',
    'application/zip',
    'application/x-rar-compressed',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'video/mp4',
    'video/webm',
    'audio/mpeg',
    'audio/wav',
    'audio/ogg'
  ],

  hashAlgorithm: 'sha256',

  quotaWarningThreshold: 0.1,

  mergeRetryAttempts: 3,

  smallFileThreshold: 10 * 1024 * 1024
};

module.exports = config;
