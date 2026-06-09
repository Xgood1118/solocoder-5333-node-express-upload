const { v4: uuidv4 } = require('uuid');
const storage = require('../storage');
const config = require('../config');

const UPLOAD_STATUS = {
  PENDING: 'pending',
  UPLOADING: 'uploading',
  MERGING: 'merging',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled'
};

class DataStore {
  constructor() {
    this.sessions = new Map();
    this.files = new Map();
    this.hashIndex = new Map();
    this.quotas = new Map();
    this.auditLogs = [];
    this._loaded = false;
  }

  async init() {
    if (this._loaded) return;

    const [sessionsData, filesData, hashIndexData, quotasData, auditData] = await Promise.all([
      storage.readJSON(storage.getDataPath('sessions.json')),
      storage.readJSON(storage.getDataPath('files.json')),
      storage.readJSON(storage.getDataPath('hashIndex.json')),
      storage.readJSON(storage.getDataPath('quotas.json')),
      storage.readJSON(storage.getDataPath('auditLogs.json'))
    ]);

    if (sessionsData) this.sessions = new Map(Object.entries(sessionsData));
    if (filesData) this.files = new Map(Object.entries(filesData));
    if (hashIndexData) this.hashIndex = new Map(Object.entries(hashIndexData));
    if (quotasData) this.quotas = new Map(Object.entries(quotasData));
    if (auditData) this.auditLogs = auditData;

    this._loaded = true;
  }

  async save() {
    await Promise.all([
      storage.writeJSON(storage.getDataPath('sessions.json'), Object.fromEntries(this.sessions)),
      storage.writeJSON(storage.getDataPath('files.json'), Object.fromEntries(this.files)),
      storage.writeJSON(storage.getDataPath('hashIndex.json'), Object.fromEntries(this.hashIndex)),
      storage.writeJSON(storage.getDataPath('quotas.json'), Object.fromEntries(this.quotas)),
      storage.writeJSON(storage.getDataPath('auditLogs.json'), this.auditLogs.slice(-10000))
    ]);
  }

  createUploadSession({ fileName, fileSize, fileHash, chunkSize, totalChunks, owner, mimeType }) {
    const uploadId = uuidv4();
    const now = Date.now();

    const session = {
      uploadId,
      fileName,
      fileSize,
      fileHash: fileHash || null,
      chunkSize,
      totalChunks,
      owner,
      mimeType,
      status: UPLOAD_STATUS.PENDING,
      uploadedChunks: [],
      uploadedBytes: 0,
      concurrentChunks: 0,
      mergeAttempts: 0,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      error: null
    };

    this.sessions.set(uploadId, session);
    this._scheduleSave();
    return session;
  }

  getUploadSession(uploadId) {
    return this.sessions.get(uploadId) || null;
  }

  updateUploadSession(uploadId, updates) {
    const session = this.sessions.get(uploadId);
    if (!session) return null;

    Object.assign(session, updates, { updatedAt: Date.now() });
    this._scheduleSave();
    return session;
  }

  addUploadedChunk(uploadId, chunkIndex, chunkSize) {
    const session = this.sessions.get(uploadId);
    if (!session) return null;

    if (!session.uploadedChunks.includes(chunkIndex)) {
      session.uploadedChunks.push(chunkIndex);
      session.uploadedChunks.sort((a, b) => a - b);
      session.uploadedBytes += chunkSize;
    }

    if (session.status === UPLOAD_STATUS.PENDING) {
      session.status = UPLOAD_STATUS.UPLOADING;
    }

    session.updatedAt = Date.now();
    this._scheduleSave();
    return session;
  }

  incrementConcurrentChunks(uploadId) {
    const session = this.sessions.get(uploadId);
    if (!session) return -1;
    session.concurrentChunks++;
    return session.concurrentChunks;
  }

  decrementConcurrentChunks(uploadId) {
    const session = this.sessions.get(uploadId);
    if (!session) return 0;
    session.concurrentChunks = Math.max(0, session.concurrentChunks - 1);
    return session.concurrentChunks;
  }

  deleteUploadSession(uploadId) {
    const deleted = this.sessions.delete(uploadId);
    if (deleted) this._scheduleSave();
    return deleted;
  }

  getExpiredSessions() {
    const now = Date.now();
    const expired = [];
    for (const session of this.sessions.values()) {
      if (session.status !== UPLOAD_STATUS.COMPLETED &&
          session.status !== UPLOAD_STATUS.CANCELLED &&
          now - session.updatedAt > config.uploadSessionTTL) {
        expired.push(session);
      }
    }
    return expired;
  }

  addFileRecord(fileRecord) {
    const fileId = fileRecord.fileId || uuidv4();
    const record = {
      ...fileRecord,
      fileId,
      createdAt: fileRecord.createdAt || Date.now(),
      owners: fileRecord.owners || [fileRecord.owner]
    };

    this.files.set(fileId, record);

    if (record.hash) {
      let hashEntry = this.hashIndex.get(record.hash);
      if (!hashEntry) {
        hashEntry = { fileId, refCount: 1, size: record.size };
        this.hashIndex.set(record.hash, hashEntry);
      } else {
        hashEntry.refCount++;
      }
    }

    this._scheduleSave();
    return record;
  }

  getFileRecord(fileId) {
    return this.files.get(fileId) || null;
  }

  getFilesByOwner(owner) {
    const result = [];
    for (const file of this.files.values()) {
      if (file.owners && file.owners.includes(owner)) {
        result.push(file);
      }
    }
    return result.sort((a, b) => b.createdAt - a.createdAt);
  }

  getAllFiles() {
    return Array.from(this.files.values()).sort((a, b) => b.createdAt - a.createdAt);
  }

  findFileByHash(hash) {
    const entry = this.hashIndex.get(hash);
    if (!entry) return null;
    return this.files.get(entry.fileId) || null;
  }

  addOwnerToFile(fileId, owner) {
    const file = this.files.get(fileId);
    if (!file) return null;

    if (!file.owners) file.owners = [];
    if (!file.owners.includes(owner)) {
      file.owners.push(owner);
    }

    const hashEntry = this.hashIndex.get(file.hash);
    if (hashEntry) {
      hashEntry.refCount++;
    }

    this._scheduleSave();
    return file;
  }

  deleteFileRecord(fileId, owner) {
    const file = this.files.get(fileId);
    if (!file) return false;

    if (owner && !file.owners.includes(owner)) {
      return false;
    }

    if (file.owners && file.owners.length > 1) {
      file.owners = file.owners.filter(o => o !== owner);

      const hashEntry = this.hashIndex.get(file.hash);
      if (hashEntry) {
        hashEntry.refCount--;
      }

      this._scheduleSave();
      return { softDelete: true };
    }

    this.files.delete(fileId);

    if (file.hash) {
      const hashEntry = this.hashIndex.get(file.hash);
      if (hashEntry) {
        hashEntry.refCount--;
        if (hashEntry.refCount <= 0) {
          this.hashIndex.delete(file.hash);
        }
      }
    }

    this._scheduleSave();
    return { hardDelete: true, filePath: file.filePath };
  }

  renameFile(fileId, newName, owner) {
    const file = this.files.get(fileId);
    if (!file) return null;

    if (owner && !file.owners.includes(owner)) {
      return null;
    }

    file.originalName = newName;
    file.updatedAt = Date.now();

    this._scheduleSave();
    return file;
  }

  getQuota(userId) {
    const now = new Date();
    const monthKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;

    let quota = this.quotas.get(userId);
    if (!quota || quota.month !== monthKey) {
      quota = {
        userId,
        month: monthKey,
        bytesUsed: 0,
        lastUpdated: Date.now(),
        warningSent: false
      };
      this.quotas.set(userId, quota);
    }

    return quota;
  }

  addQuotaUsage(userId, bytes) {
    const quota = this.getQuota(userId);
    quota.bytesUsed += bytes;
    quota.lastUpdated = Date.now();
    this._scheduleSave();
    return quota;
  }

  checkQuotaAvailable(userId, role, fileSize) {
    const quota = this.getQuota(userId);
    const roleConfig = config.roles[role] || config.roles.normal;
    const remaining = roleConfig.monthlyQuota - quota.bytesUsed;

    return {
      available: remaining >= fileSize,
      used: quota.bytesUsed,
      total: roleConfig.monthlyQuota,
      remaining: Math.max(0, remaining),
      percentage: quota.bytesUsed / roleConfig.monthlyQuota
    };
  }

  resetMonthlyQuotas() {
    const now = new Date();
    const monthKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;

    for (const [userId, quota] of this.quotas.entries()) {
      if (quota.month !== monthKey) {
        this.quotas.set(userId, {
          userId,
          month: monthKey,
          bytesUsed: 0,
          lastUpdated: Date.now(),
          warningSent: false
        });
      }
    }

    this._scheduleSave();
  }

  addAuditLog(entry) {
    this.auditLogs.push({
      ...entry,
      timestamp: Date.now()
    });
    if (this.auditLogs.length > 10000) {
      this.auditLogs = this.auditLogs.slice(-10000);
    }
    this._scheduleSave();
  }

  getAuditLogs(limit = 100, offset = 0) {
    const start = Math.max(0, this.auditLogs.length - limit - offset);
    return this.auditLogs.slice(start, start + limit).reverse();
  }

  _scheduleSave() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this.save().catch(err => console.error('Failed to save data store:', err));
    }, 1000);
  }
}

module.exports = {
  dataStore: new DataStore(),
  UPLOAD_STATUS
};
