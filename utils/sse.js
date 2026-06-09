const config = require('../config');
const { dataStore } = require('./store');

class SSEManager {
  constructor() {
    this.clients = new Map();
    this.progressTimers = new Map();
  }

  subscribe(uploadId, res) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    res.flushHeaders();

    if (!this.clients.has(uploadId)) {
      this.clients.set(uploadId, []);
    }

    const clients = this.clients.get(uploadId);
    clients.push(res);

    this._sendInitialProgress(uploadId, res);

    if (!this.progressTimers.has(uploadId)) {
      this._startProgressTimer(uploadId);
    }

    const clientId = Date.now() + Math.random();
    res._sseClientId = clientId;

    req_on_close(res, () => {
      this._removeClient(uploadId, res);
    });

    return clientId;
  }

  _sendInitialProgress(uploadId, res) {
    const session = dataStore.getUploadSession(uploadId);
    if (session) {
      const progress = this._calculateProgress(session);
      this._sendEvent(res, 'progress', progress);
    }
  }

  _calculateProgress(session) {
    const uploadedBytes = session.uploadedBytes;
    const totalBytes = session.fileSize;
    const percentage = totalBytes > 0 ? (uploadedBytes / totalBytes) * 100 : 0;

    const currentChunk = session.uploadedChunks.length > 0
      ? session.uploadedChunks[session.uploadedChunks.length - 1]
      : 0;

    return {
      uploadId: session.uploadId,
      status: session.status,
      uploadedBytes,
      totalBytes,
      percentage: Math.min(100, percentage),
      currentChunk,
      totalChunks: session.totalChunks,
      uploadedChunks: session.uploadedChunks.length,
      speed: this._calculateSpeed(session),
      estimatedTimeRemaining: this._calculateETA(session),
      timestamp: Date.now()
    };
  }

  _calculateSpeed(session) {
    if (!session._lastProgressBytes || !session._lastProgressTime) {
      session._lastProgressBytes = session.uploadedBytes;
      session._lastProgressTime = Date.now();
      return 0;
    }

    const now = Date.now();
    const timeDiff = (now - session._lastProgressTime) / 1000;
    const byteDiff = session.uploadedBytes - session._lastProgressBytes;

    if (timeDiff <= 0) return 0;

    const speed = byteDiff / timeDiff;

    session._lastProgressBytes = session.uploadedBytes;
    session._lastProgressTime = now;

    return Math.round(speed);
  }

  _calculateETA(session) {
    const speed = this._calculateSpeed(session);
    if (speed <= 0) return null;

    const remainingBytes = session.fileSize - session.uploadedBytes;
    if (remainingBytes <= 0) return 0;

    return Math.round(remainingBytes / speed);
  }

  _startProgressTimer(uploadId) {
    const timer = setInterval(() => {
      this._pushProgress(uploadId);
    }, config.ssePushInterval);

    this.progressTimers.set(uploadId, timer);
  }

  _stopProgressTimer(uploadId) {
    const timer = this.progressTimers.get(uploadId);
    if (timer) {
      clearInterval(timer);
      this.progressTimers.delete(uploadId);
    }
  }

  _pushProgress(uploadId) {
    const clients = this.clients.get(uploadId);
    if (!clients || clients.length === 0) {
      this._stopProgressTimer(uploadId);
      return;
    }

    const session = dataStore.getUploadSession(uploadId);
    if (!session) {
      this._broadcastEvent(uploadId, 'error', { message: 'Upload session not found' });
      this._cleanupUpload(uploadId);
      return;
    }

    const progress = this._calculateProgress(session);
    this._broadcastEvent(uploadId, 'progress', progress);

    if (session.status === 'completed' || session.status === 'failed' || session.status === 'cancelled') {
      this._broadcastEvent(uploadId, session.status, {
        uploadId,
        fileId: session.fileId || null,
        error: session.error || null
      });
      setTimeout(() => this._cleanupUpload(uploadId), 5000);
    }
  }

  _broadcastEvent(uploadId, event, data) {
    const clients = this.clients.get(uploadId);
    if (!clients) return;

    const message = this._formatSSE(event, data);

    for (const res of clients) {
      try {
        res.write(message);
      } catch (err) {
        this._removeClient(uploadId, res);
      }
    }
  }

  _sendEvent(res, event, data) {
    try {
      res.write(this._formatSSE(event, data));
    } catch (err) {
      // ignore
    }
  }

  _formatSSE(event, data) {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  }

  _removeClient(uploadId, res) {
    const clients = this.clients.get(uploadId);
    if (!clients) return;

    const index = clients.indexOf(res);
    if (index > -1) {
      clients.splice(index, 1);
    }

    if (clients.length === 0) {
      this.clients.delete(uploadId);
      this._stopProgressTimer(uploadId);
    }
  }

  _cleanupUpload(uploadId) {
    this._stopProgressTimer(uploadId);
    const clients = this.clients.get(uploadId);
    if (clients) {
      for (const res of clients) {
        try {
          res.end();
        } catch {
          // ignore
        }
      }
      this.clients.delete(uploadId);
    }
  }

  notifyComplete(uploadId, fileId) {
    this._broadcastEvent(uploadId, 'completed', { uploadId, fileId });
  }

  notifyError(uploadId, error) {
    this._broadcastEvent(uploadId, 'error', { uploadId, error });
  }
}

function req_on_close(res, callback) {
  res.on('close', callback);
  res.on('finish', callback);
}

module.exports = new SSEManager();
