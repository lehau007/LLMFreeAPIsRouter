import { Request, Response, NextFunction } from 'express';

export function authMiddleware(req: Request, res: Response, next: NextFunction): any {
  const authHeader = req.headers.authorization;
  const xApiKey = req.headers['x-api-key'];

  let token = '';

  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7);
  } else if (typeof xApiKey === 'string') {
    token = xApiKey;
  }

  if (!token) {
    return res.status(401).json({
      type: 'error',
      error: {
        type: 'authentication_error',
        message: 'Authentication header is missing'
      }
    });
  }

  // Valid tokens defined in environment (comma separated)
  // Format: freellmapi-v1-xxxxxxxx
  const validTokens = (process.env.CLIENT_TOKENS || '').split(',');

  // For development, if no tokens are set, allow a default one
  const isDev = process.env.NODE_ENV === 'development';
  if (isDev && token === 'dev-token') {
    return next();
  }

  if (!validTokens.includes(token)) {
    return res.status(401).json({
      type: 'error',
      error: {
        type: 'authentication_error',
        message: 'Invalid API key or token'
      }
    });
  }

  next();
}
