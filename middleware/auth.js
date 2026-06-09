const USERS = {
  'token-normal-user': { userId: 'user_normal', role: 'normal', name: 'Normal User' },
  'token-vip-user': { userId: 'user_vip', role: 'vip', name: 'VIP User' },
  'token-auditor': { userId: 'user_auditor', role: 'auditor', name: 'Auditor' }
};

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization || req.headers['x-auth-token'];
  const token = authHeader ? authHeader.replace(/^Bearer\s+/i, '') : null;

  if (!token) {
    req.user = null;
    req.isAuthenticated = false;
    return next();
  }

  const user = USERS[token];
  if (!user) {
    return res.status(401).json({ error: 'Invalid authentication token' });
  }

  req.user = user;
  req.isAuthenticated = true;
  next();
}

function requireAuth(req, res, next) {
  if (!req.isAuthenticated) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.isAuthenticated) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

function requireWritePermission(req, res, next) {
  if (!req.isAuthenticated) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  if (req.user.role === 'auditor') {
    return res.status(403).json({ error: 'Read-only access' });
  }
  next();
}

module.exports = {
  authMiddleware,
  requireAuth,
  requireRole,
  requireWritePermission,
  USERS
};
