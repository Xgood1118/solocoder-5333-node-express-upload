const Busboy = require('busboy');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const config = require('./config');
const storage = require('./storage');
const { dataStore, UPLOAD_STATUS } = require('./utils/store');
const { computeHashFromFile, computeHashFromBuffer } = require('./utils/hash');
const { detectMimeFromBuffer, validateMimeType, getExtensionFromMime } = require('./utils/mime');
const sseManager = require('./utils/sse');

function getClientIp(req) {
  return req.ip || req.connection.remoteAddress || 'unknown';
}

function getRoleConfig(role) {
  return config.roles[role] || config.roles.normal;
}

async function initUpload(req, res) {
  if (!req.isAuthenticated) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const user = req.user;
  const roleConfig = getRoleConfig(user.role);

  if (roleConfig.readOnly) {
    return res.status(403).json({ error: 'Read-only access' });
  }

  const { fileName, fileSize, fileHash, chunkSize: requestedChunkSize } = req.body;

  if (!fileName || fileSize == null) {
    return res.status(400).json({ error: 'Missing required fields: fileName, fileSize' });
  }

  if (fileSize > roleConfig.maxFileSize) {
    return res.status(413).json({
      error: 'File too large',
      maxSize: roleConfig.maxFileSize,
      fileSize
    });
  }

  const quotaInfo = dataStore.checkQuotaAvailable(user.userId, user.role, fileSize);
  if (!quotaInfo.available) {
    return res.status(429).json({
      error: 'Monthly quota exceeded',
      message: 'Monthly upload quota exceeded. Resets on the 1st of next month.',
      used: quotaInfo.used,
      total: quotaInfo.total
    });
  }

  const chunkSize = Math.min(
    Math.max(requestedChunkSize || config.defaultChunkSize,
    config.minChunkSize
  ), config.maxChunkSize);

  const totalChunks = Math.ceil(fileSize / chunkSize);

  if (fileHash) {
    const existingFile = dataStore.findFileByHash(fileHash);
    if (existingFile) {
      dataStore.addOwnerToFile(existingFile.fileId, user.userId);
      dataStore.addAuditLog({
        type: 'instant_upload',
        userId: user.userId,
        fileName,
        fileHash,
        fileId: existingFile.fileId,
        ip: getClientIp(req)
      });
      return res.json({
        instantUpload: true,
        fileId: existingFile.fileId,
        fileName: existingFile.originalName,
        fileSize: existingFile.size,
        fileHash: existingFile.hash
      });
    }
  }

  const session = dataStore.createUploadSession({
    fileName,
    fileSize,
    fileHash: fileHash || null,
    chunkSize,
    totalChunks,
    owner: user.userId,
    mimeType: null
  });

  dataStore.addAuditLog({
    type: 'upload_init',
    userId: user.userId,
    uploadId: session.uploadId,
    fileName,
    fileSize,
    ip: getClientIp(req)
  });

  res.json({
    uploadId: session.uploadId,
    chunkSize,
    totalChunks,
    maxConcurrentChunks: config.maxConcurrentChunks,
    uploadedChunks: [],
    status: session.status
  });
}

async function uploadChunk(req, res) {
  if (!req.isAuthenticated) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const user = req.user;
  const roleConfig = getRoleConfig(user.role);

  if (roleConfig.readOnly) {
    return res.status(403).json({ error: 'Read-only access' });
  }

  const { upload_id: uploadId, index: indexStr } = req.query;
  const index = parseInt(indexStr, 10);

  if (!uploadId || isNaN(index)) {
    return res.status(400).json({ error: 'Missing upload_id or index' });
  }

  const session = dataStore.getUploadSession(uploadId);
  if (!session) {
    return res.status(404).json({ error: 'Upload session not found' });
  }

  if (session.owner !== user.userId) {
    return res.status(403).json({ error: 'Not authorized for this upload' });
  }

  if (session.status === UPLOAD_STATUS.COMPLETED ||
      session.status === UPLOAD_STATUS.CANCELLED ||
      session.status === UPLOAD_STATUS.FAILED) {
    return res.status(409).json({ error: `Upload is in ${session.status} state` });
  }

  if (index < 0 || index >= session.totalChunks) {
    return res.status(400).json({ error: 'Invalid chunk index' });
  }

  const concurrentCount = dataStore.incrementConcurrentChunks(uploadId);
  session.concurrentChunks = concurrentCount;

  if (session.concurrentChunks > config.maxConcurrentChunks) {
    dataStore.decrementConcurrentChunks(uploadId);
    return res.status(429).json({
      error: 'Too many concurrent chunks',
      maxConcurrent: config.maxConcurrentChunks
    });
  }

  try {
    await _handleChunkUpload(req, res, session, index, roleConfig);
  } catch (err) {
    dataStore.decrementConcurrentChunks(uploadId);
    return res.status(500).json({ error: err.message });
  }
}

function _handleChunkUpload(req, res, session, index, roleConfig) {
  return new Promise((resolve, reject) => {
    const busboy = Busboy({ headers: req.headers });
    let chunkReceived = false;
    let firstChunk = null;
    let chunkSize = 0;

    busboy.on('file', (fieldname, fileStream, info) => {
      chunkReceived = true;

      const chunkDir = storage.getChunkDir(session.uploadId);
      const chunkFilePath = storage.getChunkPath(session.uploadId, index);

      try {
        require('fs').mkdirSync(chunkDir, { recursive: true });
      } catch (err) {
        fileStream.resume();
        reject(err);
        return;
      }

      if (roleConfig.strictMimeCheck && index === 0) {
        fileStream.once('data', (chunk) => {
          firstChunk = chunk;
          const detectedMime = detectMimeFromBuffer(chunk);
          if (detectedMime && !validateMimeType(detectedMime)) {
            fileStream.destroy(new Error('Invalid file type (MIME check failed'));
            return;
          }
          if (detectedMime) {
            session.mimeType = detectedMime;
          }
        });
      }

      const writeStream = storage.createWriteStream(chunkFilePath);
      let bytesReceived = 0;

      fileStream.on('data', (chunk) => {
        bytesReceived += chunk.length;
        chunkSize = bytesReceived;

        if (bytesReceived > session.chunkSize + 1024) {
          fileStream.destroy(new Error('Chunk size exceeds limit'));
        }
      });

      fileStream.pipe(writeStream);

      writeStream.on('finish', async () => {
        try {
          dataStore.decrementConcurrentChunks(session.uploadId);
          dataStore.addUploadedChunk(session.uploadId, index, chunkSize);

          dataStore.addAuditLog({
            type: 'chunk_upload',
            userId: session.owner,
            uploadId: session.uploadId,
            chunkIndex: index,
            chunkSize,
            ip: getClientIp(req)
          });

          res.json({
            success: true,
            uploadId: session.uploadId,
            index,
            size: chunkSize,
            uploadedChunks: dataStore.getUploadSession(session.uploadId).uploadedChunks.length,
            totalChunks: session.totalChunks
          });

          resolve();
        } catch (err) {
          reject(err);
        }
      });

      writeStream.on('error', (err) => {
        dataStore.decrementConcurrentChunks(session.uploadId);
        reject(err);
      });

      fileStream.on('error', (err) => {
        dataStore.decrementConcurrentChunks(session.uploadId);
        storage.deleteChunks(session.uploadId).catch(() => {});
        res.status(400).json({ error: err.message });
        resolve();
      });
    });

    busboy.on('finish', () => {
      if (!chunkReceived) {
        dataStore.decrementConcurrentChunks(session.uploadId);
        res.status(400).json({ error: 'No file data received' });
        resolve();
      }
    });

    busboy.on('error', (err) => {
      dataStore.decrementConcurrentChunks(session.uploadId);
      reject(err);
    });

    req.pipe(busboy);
  });
}

async function completeUpload(req, res) {
  if (!req.isAuthenticated) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const user = req.user;
  const roleConfig = getRoleConfig(user.role);

  if (roleConfig.readOnly) {
    return res.status(403).json({ error: 'Read-only access' });
  }

  const { upload_id: uploadId } = req.query;

  if (!uploadId) {
    return res.status(400).json({ error: 'Missing upload_id' });
  }

  const session = dataStore.getUploadSession(uploadId);
  if (!session) {
    return res.status(404).json({ error: 'Upload session not found' });
  }

  if (session.owner !== user.userId) {
    return res.status(403).json({ error: 'Not authorized for this upload' });
  }

  if (session.status === UPLOAD_STATUS.COMPLETED) {
    return res.json({
      fileId: session.fileId,
      fileName: session.fileName,
      fileSize: session.fileSize,
      status: session.status
    });
  }

  const uploadedChunks = await storage.listChunks(uploadId);
  const missingChunks = [];
  for (let i = 0; i < session.totalChunks; i++) {
    if (!uploadedChunks.includes(i)) {
      missingChunks.push(i);
    }
  }

  if (missingChunks.length > 0) {
    return res.status(400).json({
      error: 'Missing chunks',
      missingChunks,
      uploadedCount: uploadedChunks.length,
      totalChunks: session.totalChunks
    });
  }

  dataStore.updateUploadSession(uploadId, { status: UPLOAD_STATUS.MERGING });

  try {
    const fileId = uuidv4();
    const ext = path.extname(session.fileName) || '';
    const finalPath = storage.getUploadPath(fileId + ext);

    const freeSpace = await storage.getDiskFreeSpace();
    if (freeSpace !== Infinity && freeSpace < session.fileSize * 2) {
      throw new Error('Insufficient disk space');
    }

    await storage.mergeChunks(uploadId, session.totalChunks, finalPath);

    let fileHash = session.fileHash;
    if (!fileHash) {
      fileHash = await computeHashFromFile(finalPath);
    }

    const existingFile = dataStore.findFileByHash(fileHash);
    if (existingFile && existingFile.fileId !== fileId) {
      await storage.deleteFile(finalPath);
      dataStore.addOwnerToFile(existingFile.fileId, user.userId);

      dataStore.addAuditLog({
        type: 'upload_complete_dedup',
        userId: user.userId,
        uploadId,
        fileId: existingFile.fileId,
        fileName: session.fileName,
        fileHash,
        ip: getClientIp(req)
      });

      dataStore.addQuotaUsage(user.userId, session.fileSize);

      dataStore.updateUploadSession(uploadId, {
        status: UPLOAD_STATUS.COMPLETED,
        fileId: existingFile.fileId,
        completedAt: Date.now()
      });

      await storage.deleteChunks(uploadId);

      return res.json({
        instantUpload: true,
        deduplicated: true,
        fileId: existingFile.fileId,
        fileName: session.fileName,
        fileSize: session.fileSize,
        fileHash
      });
    }

    const fileRecord = dataStore.addFileRecord({
      fileId,
      originalName: session.fileName,
      fileName: fileId + ext,
      filePath: finalPath,
      size: session.fileSize,
      hash: fileHash,
      mimeType: session.mimeType,
      owner: user.userId,
      uploadId
    });

    dataStore.addQuotaUsage(user.userId, session.fileSize);

    dataStore.updateUploadSession(uploadId, {
      status: UPLOAD_STATUS.COMPLETED,
      fileId,
      completedAt: Date.now()
    });

    dataStore.addAuditLog({
      type: 'upload_complete',
      userId: user.userId,
      uploadId,
      fileId,
      fileName: session.fileName,
      fileSize: session.fileSize,
      fileHash,
      ip: getClientIp(req)
    });

    await storage.deleteChunks(uploadId);

    sseManager.notifyComplete(uploadId, fileId);

    res.json({
      fileId,
      fileName: session.fileName,
      fileSize: session.fileSize,
      fileHash,
      mimeType: session.mimeType
    });
  } catch (err) {
    session.mergeAttempts = (session.mergeAttempts || 0) + 1;

    if (session.mergeAttempts >= config.mergeRetryAttempts) {
      dataStore.updateUploadSession(uploadId, {
        status: UPLOAD_STATUS.FAILED,
        error: err.message
      });

      dataStore.addAuditLog({
        type: 'upload_failed',
        userId: user.userId,
        uploadId,
        error: err.message,
        ip: getClientIp(req)
      });
    } else {
      dataStore.updateUploadSession(uploadId, {
        status: UPLOAD_STATUS.UPLOADING,
        error: err.message
      });
    }

    sseManager.notifyError(uploadId, err.message);

    res.status(500).json({
      error: 'Merge failed',
      message: err.message,
      attempt: session.mergeAttempts,
      maxAttempts: config.mergeRetryAttempts
    });
  }
}

async function getUploadStatus(req, res) {
  if (!req.isAuthenticated) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const user = req.user;
  const { upload_id: uploadId } = req.query;

  if (!uploadId) {
    return res.status(400).json({ error: 'Missing upload_id' });
  }

  const session = dataStore.getUploadSession(uploadId);
  if (!session) {
    return res.status(404).json({ error: 'Upload session not found' });
  }

  if (session.owner !== user.userId && user.role !== 'auditor') {
    return res.status(403).json({ error: 'Not authorized' });
  }

  const uploadedChunks = await storage.listChunks(uploadId);

  res.json({
    uploadId,
    status: session.status,
    fileName: session.fileName,
    fileSize: session.fileSize,
    chunkSize: session.chunkSize,
    totalChunks: session.totalChunks,
    uploadedChunks,
    uploadedBytes: session.uploadedBytes,
    percentage: session.fileSize > 0 ? (session.uploadedBytes / session.fileSize) * 100 : 0,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    expiresAt: session.createdAt + config.uploadSessionTTL
  });
}

async function abortUpload(req, res) {
  if (!req.isAuthenticated) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const user = req.user;
  const { upload_id: uploadId } = req.query;

  if (!uploadId) {
    return res.status(400).json({ error: 'Missing upload_id' });
  }

  const session = dataStore.getUploadSession(uploadId);
  if (!session) {
    return res.status(404).json({ error: 'Upload session not found' });
  }

  if (session.owner !== user.userId) {
    return res.status(403).json({ error: 'Not authorized' });
  }

  if (session.status === UPLOAD_STATUS.COMPLETED ||
      session.status === UPLOAD_STATUS.CANCELLED) {
    return res.json({ success: true, status: session.status });
  }

  dataStore.updateUploadSession(uploadId, { status: UPLOAD_STATUS.CANCELLED });

  await storage.deleteChunks(uploadId);

  dataStore.addAuditLog({
    type: 'upload_abort',
    userId: user.userId,
    uploadId,
    ip: getClientIp(req)
  });

  res.json({
    success: true,
    status: UPLOAD_STATUS.CANCELLED
  });
}

async function checkHash(req, res) {
  if (!req.isAuthenticated) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const user = req.user;
  const { hash } = req.query;

  if (!hash) {
    return res.status(400).json({ error: 'Missing hash' });
  }

  const existingFile = dataStore.findFileByHash(hash);

  if (existingFile) {
    dataStore.addAuditLog({
      type: 'hash_check_hit',
      userId: user.userId,
      fileHash: hash,
      fileId: existingFile.fileId,
      ip: getClientIp(req)
    });

    return res.json({
      exists: true,
      fileId: existingFile.fileId,
      fileName: existingFile.originalName,
      fileSize: existingFile.size
    });
  }

  dataStore.addAuditLog({
    type: 'hash_check_miss',
    userId: user.userId,
    fileHash: hash,
    ip: getClientIp(req)
  });

  res.json({ exists: false });
}

async function simpleUpload(req, res) {
  if (!req.isAuthenticated) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const user = req.user;
  const roleConfig = getRoleConfig(user.role);

  if (roleConfig.readOnly) {
    return res.status(403).json({ error: 'Read-only access' });
  }

  const busboy = Busboy({
    headers: req.headers,
    limits: {
      fileSize: roleConfig.maxFileSize,
      files: 10
    }
  });

  const uploadedFiles = [];
  let totalFiles = 0;
  let finishedFiles = 0;
  let hasError = false;
  let responseSent = false;

  function sendFinalResponse() {
    if (responseSent) return;
    responseSent = true;

    if (!hasError) {
      dataStore.addAuditLog({
        type: 'simple_upload',
        userId: user.userId,
        fileCount: uploadedFiles.length,
        ip: getClientIp(req)
      });

      res.json({
        files: uploadedFiles,
        count: uploadedFiles.length
      });
    }
  }

  busboy.on('file', (fieldname, fileStream, info) => {
    totalFiles++;
    const fileName = info.filename || 'unnamed';
    const fileId = uuidv4();
    const ext = path.extname(fileName) || '';
    const finalPath = storage.getUploadPath(fileId + ext);

    let fileSize = 0;
    let detectedMime = null;
    let firstChunk = true;

    const writeStream = storage.createWriteStream(finalPath);

    fileStream.on('data', (chunk) => {
      fileSize += chunk.length;

      if (firstChunk && roleConfig.strictMimeCheck) {
        firstChunk = false;
        detectedMime = detectMimeFromBuffer(chunk);
        if (detectedMime && !validateMimeType(detectedMime)) {
          fileStream.destroy(new Error('Invalid file type (MIME check failed)'));
        }
      }
    });

    fileStream.pipe(writeStream);

    writeStream.on('finish', async () => {
      try {
        if (hasError) {
          finishedFiles++;
          if (finishedFiles >= totalFiles && !responseSent) {
            sendFinalResponse();
          }
          return;
        }

        const quotaInfo = dataStore.checkQuotaAvailable(user.userId, user.role, fileSize);
        if (!quotaInfo.available) {
          await storage.deleteFile(finalPath);
          hasError = true;
          if (!responseSent) {
            responseSent = true;
            res.status(429).json({
              error: 'Monthly quota exceeded',
              message: 'Monthly upload quota exceeded. Resets on the 1st of next month.',
              used: quotaInfo.used,
              total: quotaInfo.total
            });
          }
          finishedFiles++;
          return;
        }

        const fileHash = await computeHashFromFile(finalPath);

        const existingFile = dataStore.findFileByHash(fileHash);
        if (existingFile) {
          await storage.deleteFile(finalPath);
          dataStore.addOwnerToFile(existingFile.fileId, user.userId);
          dataStore.addQuotaUsage(user.userId, fileSize);

          uploadedFiles.push({
            fileId: existingFile.fileId,
            name: fileName,
            size: fileSize,
            hash: fileHash,
            instantUpload: true
          });
        } else {
          dataStore.addFileRecord({
            fileId,
            originalName: fileName,
            fileName: fileId + ext,
            filePath: finalPath,
            size: fileSize,
            hash: fileHash,
            mimeType: detectedMime,
            owner: user.userId
          });

          dataStore.addQuotaUsage(user.userId, fileSize);

          uploadedFiles.push({
            fileId,
            name: fileName,
            size: fileSize,
            hash: fileHash,
            mimeType: detectedMime
          });
        }

        finishedFiles++;
        if (finishedFiles >= totalFiles && !responseSent) {
          sendFinalResponse();
        }
      } catch (err) {
        hasError = true;
        finishedFiles++;
        if (!responseSent) {
          responseSent = true;
          res.status(500).json({ error: err.message });
        }
      }
    });

    fileStream.on('error', async (err) => {
      hasError = true;
      await storage.deleteFile(finalPath).catch(() => {});
      if (!responseSent) {
        responseSent = true;
        res.status(400).json({ error: err.message });
      }
      finishedFiles++;
    });

    writeStream.on('error', async (err) => {
      hasError = true;
      await storage.deleteFile(finalPath).catch(() => {});
      if (!responseSent) {
        responseSent = true;
        res.status(500).json({ error: err.message });
      }
      finishedFiles++;
    });
  });

  busboy.on('finish', () => {
    if (totalFiles === 0 && !responseSent) {
      responseSent = true;
      res.status(400).json({ error: 'No files uploaded' });
    } else if (finishedFiles >= totalFiles && !responseSent) {
      sendFinalResponse();
    }
  });

  busboy.on('error', (err) => {
    if (!responseSent) {
      responseSent = true;
      res.status(400).json({ error: err.message });
    }
  });

  req.pipe(busboy);
}

module.exports = {
  initUpload,
  uploadChunk,
  completeUpload,
  getUploadStatus,
  abortUpload,
  checkHash,
  simpleUpload
};
