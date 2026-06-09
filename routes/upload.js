const express = require('express');
const upload = require('../upload');
const sseManager = require('../utils/sse');
const { dataStore } = require('../utils/store');
const { requireAuth, requireWritePermission } = require('../middleware/auth');
const { fileCountMiddleware } = require('../middleware/rateLimit');

const router = express.Router();

router.post('/init', requireAuth, requireWritePermission, fileCountMiddleware, (req, res) => {
  upload.initUpload(req, res);
});

router.post('/simple', requireAuth, requireWritePermission, fileCountMiddleware, (req, res) => {
  upload.simpleUpload(req, res);
});

router.post('/chunk', requireAuth, requireWritePermission, (req, res) => {
  upload.uploadChunk(req, res);
});

router.post('/complete', requireAuth, requireWritePermission, (req, res) => {
  upload.completeUpload(req, res);
});

router.get('/status', requireAuth, (req, res) => {
  upload.getUploadStatus(req, res);
});

router.post('/abort', requireAuth, requireWritePermission, (req, res) => {
  upload.abortUpload(req, res);
});

router.get('/hash/check', requireAuth, (req, res) => {
  upload.checkHash(req, res);
});

router.get('/progress/:uploadId', (req, res) => {
  const { uploadId } = req.params;
  const session = dataStore.getUploadSession(uploadId);

  if (!session) {
    return res.status(404).json({ error: 'Upload session not found' });
  }

  if (req.isAuthenticated && req.user &&
      session.owner !== req.user.userId &&
      req.user.role !== 'auditor') {
    return res.status(403).json({ error: 'Not authorized' });
  }

  sseManager.subscribe(uploadId, res, req);
});

module.exports = router;
