import dotenv from 'dotenv';
import { z } from 'zod';
import path from 'path';

// Load .env file
dotenv.config();

const ConfigSchema = z.object({
  minecraft: z.object({
    host: z.string().default('localhost'),
    port: z.number().int().positive().default(25565),
    username: z.string().default('MIKA_Bot'),
    version: z.string().optional().nullable(),
    auth: z.enum(['offline', 'microsoft']).default('offline')
  }),
  ollama: z.object({
    host: z.string().default('http://localhost:11434'),
    model: z.string().default('qwen3.5:9b')
  }),
  llm: z.object({
    baseUrl: z.string().default('http://localhost:11434'),
    model: z.string().default('qwen3.5:9b'),
    apiKey: z.string().default(''),
    timeoutMs: z.number().int().positive().default(45000)
  }),
  storage: z.object({
    dataDir: z.string().default('./data'),
    experiencesPath: z.string().default('./data/raw/experiences.jsonl'),
    feedbackPath: z.string().default('./data/raw/feedback.jsonl')
  }),
  app: z.object({
    logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info')
  })
});

const rawConfig = {
  minecraft: {
    host: process.env.MC_HOST || 'localhost',
    port: process.env.MC_PORT ? parseInt(process.env.MC_PORT, 10) : 25565,
    username: process.env.MC_USERNAME || 'MIKA_Bot',
    version: process.env.MC_VERSION && process.env.MC_VERSION !== 'false' ? process.env.MC_VERSION : undefined,
    auth: process.env.MC_AUTH || 'offline'
  },
  ollama: {
    host: process.env.OLLAMA_HOST || 'http://localhost:11434',
    model: process.env.OLLAMA_MODEL || 'qwen3.5:9b'
  },
  llm: {
    baseUrl: process.env.LLM_BASE_URL || process.env.OLLAMA_HOST || 'http://localhost:11434',
    model: process.env.LLM_MODEL || process.env.OLLAMA_MODEL || 'qwen3.5:9b',
    apiKey: process.env.LLM_API_KEY || '',
    timeoutMs: process.env.LLM_TIMEOUT_MS ? parseInt(process.env.LLM_TIMEOUT_MS, 10) : 45000
  },
  storage: {
    dataDir: process.env.DATA_DIR || './data',
    experiencesPath: path.join(process.env.DATA_DIR || './data', 'raw', 'experiences.jsonl'),
    feedbackPath: path.join(process.env.DATA_DIR || './data', 'raw', 'feedback.jsonl')
  },
  app: {
    logLevel: process.env.LOG_LEVEL || 'info'
  }
};

export const config = ConfigSchema.parse(rawConfig);
export default config;
