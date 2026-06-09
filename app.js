const express = require('express');
const config = require('./config');
const storage = require('./storage');
const { dataStore } = require('./utils/store');
const cleanupManager = require('./utils/cleanup');
const { authMiddleware } = require('./middleware/auth');
const { bandwidthMiddleware } = require('./middleware/rateLimit');

const uploadRoutes = require('./routes/upload');
const fileRoutes = require('./routes/files');

const app = express();

app.set('trust proxy', true);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} - ${req.ip}`);
  next();
});

app.use(authMiddleware);

app.get('/', (req, res) => {
  res.json({
    name: 'Node Express Upload Service',
    version: '1.0.0',
    endpoints: {
      upload: {
        init: 'POST /upload/init',
        chunk: 'POST /upload/chunk?upload_id=xxx&index=N',
        complete: 'POST /upload/complete?upload_id=xxx',
        status: 'GET /upload/status?upload_id=xxx',
        abort: 'POST /upload/abort?upload_id=xxx',
        hashCheck: 'GET /upload/hash/check?hash=xxx',
        progress: 'GET /upload/progress/:uploadId (SSE)'
      },
      files: {
        list: 'GET /files',
        get: 'GET /files/:id',
        download: 'GET /files/:id/download',
        delete: 'DELETE /files/:id',
        rename: 'PATCH /files/:id/rename',
        quota: 'GET /files/quota/usage'
      }
    },
    auth: {
      normal: 'token-normal-user',
      vip: 'token-vip-user',
      auditor: 'token-auditor'
    }
  });
});

app.use('/upload', bandwidthMiddleware, uploadRoutes);
app.use('/files', fileRoutes);

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({
    error: 'Internal server error',
    message: err.message
  });
});

async function startServer() {
  try {
    await storage.init();
    await dataStore.init();

    cleanupManager.start();

    const server = app.listen(config.port, () => {
      console.log(`\nServer running on http://localhost:${config.port}`);
      console.log(`Upload dir: ${config.uploadDir}`);
      console.log(`Chunk dir: ${config.chunkDir}`);
      console.log(`Data dir: ${config.dataDir}`);
      console.log(`\nAuth tokens:`);
      console.log(`  Normal user: token-normal-user (100MB/file, 5GB/month)`);
      console.log(`  VIP user:    token-vip-user (500MB/file, 50GB/month)`);
      console.log(`  Auditor:     token-auditor (read-only)`);
    });

    const gracefulShutdown = (signal) => {
      console.log(`\nReceived ${signal}, shutting down gracefully...`);
      cleanupManager.stop();
      dataStore.save().then(() => {
        server.close(() => {
          console.log('Server closed');
          process.exit(0);
        });
      });
    };

    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

startServer();

module.exports = app;
