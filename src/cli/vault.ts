import { EncryptionUtil } from '../utils/encryption';
import { config } from '../config/env';
import * as readline from 'readline';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function ask(question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve));
}

async function main() {
  console.log('--- LLMFreeAPIsRouter Vault Utility ---');
  
  if (!config.masterKey) {
    console.error('Error: MASTER_KEY environment variable not set.');
    process.exit(1);
  }

  const action = await ask('Choose action: (e)ncrypt or (d)ecrypt? ');

  if (action.toLowerCase() === 'e') {
    const text = await ask('Enter plain text to encrypt: ');
    try {
      const encrypted = EncryptionUtil.encrypt(text, config.masterKey);
      console.log('\nEncrypted string:');
      console.log(encrypted);
      console.log('\nCopy this to your provider configuration.');
    } catch (err: any) {
      console.error('Encryption failed:', err.message);
    }
  } else if (action.toLowerCase() === 'd') {
    const encrypted = await ask('Enter encrypted string: ');
    try {
      const decrypted = EncryptionUtil.decrypt(encrypted, config.masterKey);
      console.log('\nDecrypted text:');
      console.log(decrypted);
    } catch (err: any) {
      console.error('Decryption failed. Ensure your MASTER_KEY is correct.');
    }
  } else {
    console.log('Invalid action.');
  }

  rl.close();
}

main();
