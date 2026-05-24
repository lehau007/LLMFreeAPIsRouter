import { Router as ExpressRouter, Request, Response } from 'express';
import { Router as CustomRouter, RouteContext } from '../router';
import { getProvidersConfig } from '../config/providers';
import { GoogleProvider } from '../providers/google';
import { GroqProvider } from '../providers/groq';
import { ChatRequest } from '../types';
import { setLock, getLock, clearLock } from '../utils/modelLock';

const router = ExpressRouter();

// Initialize Router
const configs = getProvidersConfig();
const providers = configs.map(config => {
  if (config.name === 'Google') return new GoogleProvider(config);
  if (config.name === 'Groq') return new GroqProvider(config);
  throw new Error(`Unknown provider: ${config.name}`);
});

const appRouter = new CustomRouter(providers);

router.post('/', async (req: Request, res: Response): Promise<any> => {
  try {
    const chatRequest: ChatRequest = req.body;
    
    if (!chatRequest.model || !chatRequest.messages || chatRequest.max_tokens === undefined) {
      return res.status(400).json({ error: 'Missing required fields: model, messages, max_tokens' });
    }

    const rawMode = req.headers['x-routing-mode'];
    const mode: 'strict' | 'flexible' = (rawMode === 'strict' || rawMode === 'flexible') ? rawMode : 'flexible';
    const clientToken: string = res.locals.clientToken;

    // Handle x-lock-model header
    const lockHeader = req.headers['x-lock-model'] as string | undefined;
    if (lockHeader) {
      if (lockHeader === 'clear') {
        clearLock(clientToken);
      } else {
        // Accepts "providerName:providerModelId" or "providerName:providerModelId:v1"
        const parts = lockHeader.replace(/:v\d+$/, '').split(':');
        if (parts.length >= 2) {
          const providerName = parts[0];
          const providerModelId = parts.slice(1).join(':');
          setLock(clientToken, providerName, providerModelId);
        }
      }
    }

    const lockedTarget = getLock(clientToken) ?? undefined;
    const ctx: RouteContext = { attempts: 0 };

    // Handle Streaming
    if (chatRequest.stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      try {
        const stream = appRouter.routeStreamChat(chatRequest, mode, lockedTarget, ctx);
        let isFirstEvent = true;
        for await (const event of stream) {
          if (isFirstEvent && event.type === 'message_start' && event.message?.model) {
            res.setHeader('x-actual-model', event.message.model);
            res.setHeader('x-fallback-attempts', String(Math.max(0, ctx.attempts - 1)));
            isFirstEvent = false;
          }
          res.write(`event: ${event.type}\n`);
          res.write(`data: ${JSON.stringify(event)}\n\n`);
          
          if (event.type === 'message_stop' || event.type === 'error') {
            break;
          }
        }
      } catch (streamError: any) {
        console.error('Stream processing error:', streamError);
        res.write(`event: error\n`);
        res.write(`data: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message: streamError.message } })}\n\n`);
      } finally {
        res.end();
      }
      return;
    }

    // Handle Non-Streaming
    const response = await appRouter.routeChat(chatRequest, mode, lockedTarget, ctx);
    res.setHeader('x-actual-model', response.model);
    res.setHeader('x-fallback-attempts', String(Math.max(0, ctx.attempts - 1)));
    return res.status(200).json(response);

  } catch (error: any) {
    console.error('Routing Error:', error);
    let statusCode = 500;
    let errType = 'api_error';
    
    const errMessage = error.message || '';
    if (error?.name === 'InvalidImageURLError') {
      statusCode = 400;
      errType = 'invalid_request_error';
    } else if (errMessage.includes('429') || errMessage.includes('Quota Exceeded')) {
      statusCode = 429;
      errType = 'rate_limit_error';
    } else if (errMessage.includes('502') || errMessage.includes('503') || errMessage.includes('504')) {
      statusCode = 500;
      errType = 'overloaded_error';
    } else if (errMessage.includes('400') || errMessage.includes('422')) {
      statusCode = 400;
      errType = 'invalid_request_error';
    } else if (errMessage.includes('Timeout') || errMessage.includes('Conn. Reset') || errMessage.includes('reset') || typeof errMessage === 'string') {
      // Defaults to 500 / api_error which we initialized
    }

    return res.status(statusCode).json({
      type: 'error',
      error: {
        type: errType,
        message: errMessage || 'Internal Server Error'
      }
    });
  }
});

export default router;
