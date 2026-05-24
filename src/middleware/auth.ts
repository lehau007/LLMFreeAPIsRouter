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
  const validTokens = (process.env.CLIENT_TOKENS || '').split(',').map(t => t.trim());

  if (!validTokens.includes(token)) {
    return res.status(401).json({
      type: 'error',
      error: {
        type: 'authentication_error',
        message: 'Invalid API key or token'
      }
    });
  }

  res.locals.clientToken = token;
  next();
}
