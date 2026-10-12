import { Ollama } from 'ollama';
import config from '../config/index.js';

export const ollamaClient = new Ollama({
  host: config.ollama.host
});

/**
 * Fast availability check (under 50ms) to ensure Ollama is up and the model is loaded.
 */
export async function checkQwenAvailable() {
  try {
    const tags = await ollamaClient.list();
    const modelFound = tags.models.find(m => 
      m.name === config.ollama.model || 
      m.name === `${config.ollama.model}:latest` ||
      m.model === config.ollama.model
    );
    return {
      available: !!modelFound,
      model: modelFound
    };
  } catch (err) {
    return {
      available: false,
      error: err.message
    };
  }
}

/**
 * Verifies connectivity to the local Ollama instance and confirms the model is loaded.
 */
export async function testQwenConnection() {
  console.log(`[Qwen] Connecting to Ollama at ${config.ollama.host}...`);
  try {
    const tags = await ollamaClient.list();
    const modelFound = tags.models.find(m => 
      m.name === config.ollama.model || 
      m.name === `${config.ollama.model}:latest` ||
      m.model === config.ollama.model
    );

    if (!modelFound) {
      console.warn(`[Qwen] Warning: Model '${config.ollama.model}' not found in Ollama tags! Available models:`, tags.models.map(m => m.name));
    } else {
      console.log(`[Qwen] Found target model '${config.ollama.model}' (${(modelFound.size / 1e9).toFixed(2)} GB)`);
    }

    console.log(`[Qwen] Testing structured inference with ${config.ollama.model}...`);
    const startTime = Date.now();
    const response = await ollamaClient.chat({
      model: config.ollama.model,
      messages: [
        {
          role: 'system',
          content: 'You are MIKA, an autonomous Minecraft ALife bot decision system. Respond strictly in valid JSON.'
        },
        {
          role: 'user',
          content: 'State test: Are you ready to make decisions for Minecraft? Return JSON: {"ready": true, "system": "MIKA", "model": "qwen3.5:9b"}'
        }
      ],
      format: 'json',
      options: {
        temperature: 0.2
      }
    });

    const duration = Date.now() - startTime;
    console.log(`[Qwen] Test response received in ${duration}ms:`, response.message.content.trim());
    return {
      success: true,
      durationMs: duration,
      content: JSON.parse(response.message.content)
    };
  } catch (err) {
    console.error(`[Qwen] Ollama connection error:`, err.message);
    return {
      success: false,
      error: err.message
    };
  }
}

/**
 * Ask Qwen for a structured decision given current state, allowed actions, and prior memories.
 */
export async function planNextAction({ observation, availableActions, memories = [], goal = 'survive and explore' }) {
  const systemPrompt = `You are MIKA, an autonomous Minecraft survival bot.
You make high-level decisions. You must return ONLY a JSON object with this exact structure:
{
  "goal": "string (the short-term objective)",
  "reason_summary": "string (concise reason based strictly on observation)",
  "action": "string (MUST be one of the available_actions)",
  "arguments": {},
  "expected_outcome": "string (what should measurably change in world or inventory)",
  "risk": "low" | "medium" | "high",
  "confidence": 0.0 to 1.0
}
Strict rules:
1. Do not invent items or blocks not in the observation.
2. Select an action ONLY from the provided available_actions.
3. Be concise and prioritize survival and resource efficiency.`;

  const userPrompt = JSON.stringify({
    goal,
    observation,
    available_actions: availableActions,
    past_memories: memories
  }, null, 2);

  const response = await ollamaClient.chat({
    model: config.ollama.model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    format: 'json',
    options: {
      temperature: 0.2
    }
  });

  try {
    const parsed = JSON.parse(response.message.content);
    return parsed;
  } catch (e) {
    throw new Error(`Failed to parse Qwen JSON response: ${response.message.content}`);
  }
}
