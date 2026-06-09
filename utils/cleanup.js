const config = require('../config');
const storage = require('../storage');
const { dataStore, UPLOAD_STATUS } = require('./store');

class CleanupManager {
  constructor() {
    this._interval = null;
    this._running = false;
  }

  start() {
    if (this._interval) return;

    this._interval = setInterval(() => {
      this.runCleanup().catch(err => {
        console.error('Cleanup error:', err);
      });
    }, config.cleanupInterval);

    console.log(`[Cleanup] Started, interval: ${config.cleanupInterval / 1000}s`);
  }

  stop() {
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }
  }

  async runCleanup() {
    if (this._running) return;
    this._running = true;

    try {
      const expiredCount = await this._cleanupExpiredSessions();
      const quotaReset = await this._checkQuotaReset();

      if (expiredCount > 0 || quotaReset) {
        console.log(`[Cleanup] Expired sessions: ${expiredCount}, Quota reset: ${quotaReset}`);
      }
    } finally {
      this._running = false;
    }
  }

  async _cleanupExpiredSessions() {
    const expiredSessions = dataStore.getExpiredSessions();
    let count = 0;

    for (const session of expiredSessions) {
      try {
        dataStore.updateUploadSession(session.uploadId, {
          status: UPLOAD_STATUS.CANCELLED,
          error: 'Session expired (24h timeout)'
        });

        await storage.deleteChunks(session.uploadId);

        dataStore.addAuditLog({
          type: 'session_timeout',
          uploadId: session.uploadId,
          userId: session.owner,
          fileName: session.fileName
        });

        count++;
      } catch (err) {
        console.error(`Failed to cleanup session ${session.uploadId}:`, err);
      }
    }

    return count;
  }

  async _checkQuotaReset() {
    const now = new Date();
    const currentMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;

    let needsReset = false;
    for (const quota of dataStore.quotas.values()) {
      if (quota.month !== currentMonth) {
        needsReset = true;
        break;
      }
    }

    if (needsReset) {
      dataStore.resetMonthlyQuotas();
      dataStore.addAuditLog({
        type: 'quota_reset',
        month: currentMonth
      });
      return true;
    }

    return false;
  }

  async _checkQuotaWarnings() {
    const warnings = [];

    for (const [userId, quota] of dataStore.quotas.entries()) {
      const userRole = this._getUserRole(userId);
      const roleConfig = config.roles[userRole] || config.roles.normal;
      const percentage = quota.bytesUsed / roleConfig.monthlyQuota;

      if (percentage >= (1 - config.quotaWarningThreshold) && !quota.warningSent) {
        quota.warningSent = true;
        warnings.push({ userId, percentage });

        dataStore.addAuditLog({
          type: 'quota_warning',
          userId,
          percentage,
          used: quota.bytesUsed,
          total: roleConfig.monthlyQuota
        });
      }
    }

    return warnings;
  }

  _getUserRole(userId) {
    const userMap = {
      'user_normal': 'normal',
      'user_vip': 'vip',
      'user_auditor': 'auditor'
    };
    return userMap[userId] || 'normal';
  }
}

module.exports = new CleanupManager();
