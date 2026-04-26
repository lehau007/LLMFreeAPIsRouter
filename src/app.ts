import express from 'express';
import messagesRouter from './routes/messages';
import { authMiddleware } from './middleware/auth';

const app = express();

app.use(express.json());

// API Routes protected by auth
app.use('/v1/messages', authMiddleware, messagesRouter);

// Health check endpoint (public)
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

export default app;
