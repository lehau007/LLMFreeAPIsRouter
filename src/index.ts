import app from './app';
import { config, validateEnv } from './config/env';

// Validate environment variables before starting
validateEnv();

const PORT = config.port;

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  console.log(`Environment: ${config.nodeEnv}`);
});
