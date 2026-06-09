const express = require('express');
const path = require('path');
const { dataStore } = require('../utils/store');
const storage = require('../storage');
const { requireAuth, requireRole, requireWritePermission } = require('../middleware/auth');

const router = express.Router();

function getClientIp(req) {
  return req.ip || req.connection.remoteAddress || 'unknown';
}

router.get('/', requireAuth, async (req, res) => {
  const user = req.user;
  const { limit = 50, offset = 0 } = req.query;

  let files;
  if (user.role === 'auditor') {
    files = dataStore.getAllFiles();
  } else {
    files = dataStore.getFilesByOwner(user.userId);
  }

  const start = parseInt(offset, 10);
  const count = parseInt(limit, 10);
  const paginated = files.slice(start, start + count);

  const result = paginated.map(f => ({
    fileId: f.fileId,
    name: f.originalName,
    size: f.size,
    hash: f.hash,
    mimeType: f.mimeType,
    createdAt: f.createdAt,
    owners: f.owners
  }));

  res.json({
    files: result,
    total: files.length,
    offset: start,
    limit: count
  });
});

router.get('/:id', requireAuth, async (req, res) => {
  const user = req.user;
  const { id } = req.params;

  const file = dataStore.getFileRecord(id);
  if (!file) {
    return res.status(404).json({ error: 'File not found' });
  }

  if (user.role !== 'auditor' && !file.owners.includes(user.userId)) {
    return res.status(403).json({ error: 'Not authorized' });
  }

  res.json({
    fileId: file.fileId,
    name: file.originalName,
    size: file.size,
    hash: file.hash,
    mimeType: file.mimeType,
    createdAt: file.createdAt,
    owners: file.owners,
    uploadId: file.uploadId
  });
});

router.get('/:id/download', requireAuth, async (req, res) => {
  const user = req.user;
  const { id } = req.params;

  const file = dataStore.getFileRecord(id);
  if (!file) {
    return res.status(404).json({ error: 'File not found' });
  }

  if (user.role !== 'auditor' && !file.owners.includes(user.userId)) {
    return res.status(403).json({ error: 'Not authorized' });
  }

  const filePath = file.filePath;

  if (!await storage.fileExists(filePath)) {
    return res.status(404).json({ error: 'File not found on disk' });
  }

  const fileSize = file.size;
  const rangeHeader = req.headers.range;

  if (rangeHeader) {
    const rangeMatch = rangeHeader.match(/^bytes=(\d*)-(\d*)$/);
    if (rangeMatch) {
      let start = rangeMatch[1] ? parseInt(rangeMatch[1], 10) : null;
      let end = rangeMatch[2] ? parseInt(rangeMatch[2], 10) : null;

      if (start === null && end !== null) {
        start = fileSize - end;
        end = fileSize - 1;
      } else if (end === null || end >= fileSize) {
        end = fileSize - 1;
      }

      if (start > end || start >= fileSize) {
        res.set('Content-Range', `bytes */${fileSize}`);
        return res.status(416).json({ error: 'Requested range not satisfiable' });
      }

      const contentLength = end - start + 1;
      res.status(206);
      res.set('Content-Range', `bytes ${start}-${end}/${fileSize}`);
      res.set('Accept-Ranges', 'bytes');
      res.set('Content-Length', String(contentLength));
      res.set('Content-Type', file.mimeType || 'application/octet-stream');
      res.set('Content-Disposition', `attachment; filename="${encodeURIComponent(file.originalName)}"`);

      const stream = storage.createReadStream(filePath, { start, end });
      stream.pipe(res);

      stream.on('error', () => {
        if (!res.headersSent) {
          res.status(500).json({ error: 'Failed to read file' });
        }
      });

      return;
    }
  }

  res.set('Content-Type', file.mimeType || 'application/octet-stream');
  res.set('Content-Length', String(fileSize));
  res.set('Content-Disposition', `attachment; filename="${encodeURIComponent(file.originalName)}"`);
  res.set('Accept-Ranges', 'bytes');

  const stream = storage.createReadStream(filePath);
  stream.pipe(res);

  stream.on('error', () => {
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to read file' });
    }
  });
});

router.delete('/:id', requireAuth, requireWritePermission, async (req, res) => {
  const user = req.user;
  const { id } = req.params;

  const file = dataStore.getFileRecord(id);
  if (!file) {
    return res.status(404).json({ error: 'File not found' });
  }

  if (!file.owners.includes(user.userId)) {
    return res.status(403).json({ error: 'Not authorized' });
  }

  const result = dataStore.deleteFileRecord(id, user.userId);

  if (result === false) {
    return res.status(403).json({ error: 'Not authorized' });
  }

  if (result.hardDelete && result.filePath) {
    await storage.deleteFile(result.filePath);

    dataStore.addAuditLog({
      type: 'file_delete',
      userId: user.userId,
      fileId: id,
      fileName: file.originalName,
      fileSize: file.size,
      hardDelete: true,
      ip: getClientIp(req)
    });
  } else {
    dataStore.addAuditLog({
      type: 'file_delete',
      userId: user.userId,
      fileId: id,
      fileName: file.originalName,
      hardDelete: false,
      ip: getClientIp(req)
    });
  }

  res.json({
    success: true,
    hardDelete: !!result.hardDelete
  });
});

router.patch('/:id/rename', requireAuth, requireWritePermission, async (req, res) => {
  const user = req.user;
  const { id } = req.params;
  const { name } = req.body;

  if (!name || name.trim().length === 0) {
    return res.status(400).json({ error: 'New name is required' });
  }

  const file = dataStore.getFileRecord(id);
  if (!file) {
    return res.status(404).json({ error: 'File not found' });
  }

  if (!file.owners.includes(user.userId)) {
    return res.status(403).json({ error: 'Not authorized' });
  }

  const updated = dataStore.renameFile(id, name.trim(), user.userId);
  if (!updated) {
    return res.status(403).json({ error: 'Not authorized' });
  }

  dataStore.addAuditLog({
    type: 'file_rename',
    userId: user.userId,
    fileId: id,
    oldName: file.originalName,
    newName: name.trim(),
    ip: getClientIp(req)
  });

  res.json({
    fileId: updated.fileId,
    name: updated.originalName,
    size: updated.size,
    hash: updated.hash,
    updatedAt: updated.updatedAt
  });
});

router.get('/quota/usage', requireAuth, async (req, res) => {
  const user = req.user;
  const roleConfig = require('../config').roles[user.role] || require('../config').roles.normal;

  const quota = dataStore.getQuota(user.userId);

  res.json({
    role: user.role,
    total: roleConfig.monthlyQuota,
    used: quota.bytesUsed,
    remaining: Math.max(0, roleConfig.monthlyQuota - quota.bytesUsed),
    percentage: quota.bytesUsed / roleConfig.monthlyQuota,
    month: quota.month,
    maxFileSize: roleConfig.maxFileSize
  });
});

router.get('/audit/logs', requireRole('auditor'), async (req, res) => {
  const { limit = 100, offset = 0 } = req.query;
  const logs = dataStore.getAuditLogs(parseInt(limit, 10), parseInt(offset, 10));

  res.json({
    logs,
    total: dataStore.auditLogs ? dataStore.auditLogs.length : 0
  });
});

module.exports = router;
