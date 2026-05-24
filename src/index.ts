import app from './app';
import { config, validateEnv } from './config/env';
import { cleanupOldLogs } from './utils/logger';

validateEnv();
cleanupOldLogs();

const PORT = config.port;

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  console.log(`Environment: ${config.nodeEnv}`);
});
