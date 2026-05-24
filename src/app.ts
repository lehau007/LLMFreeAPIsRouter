import express, { Request, Response } from 'express';
import messagesRouter from './routes/messages';
import { authMiddleware } from './middleware/auth';
import { getLock, clearLock } from './utils/modelLock';

const app = express();

app.use(express.json());

// API Routes protected by auth
app.use('/v1/messages', authMiddleware, messagesRouter);

app.get('/v1/model-lock', authMiddleware, (_req: Request, res: Response) => {
  const lock = getLock(res.locals.clientToken);
  if (!lock) return res.status(200).json({ locked: false });
  return res.status(200).json({ locked: true, provider: lock.providerName, model: lock.providerModelId });
});

app.delete('/v1/model-lock', authMiddleware, (_req: Request, res: Response) => {
  clearLock(res.locals.clientToken);
  return res.status(200).json({ locked: false });
});

// Health check endpoint (public)
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

export default app;
