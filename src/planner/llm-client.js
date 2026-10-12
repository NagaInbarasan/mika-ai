import config from '../config/index.js';

export class LLMClient {
  constructor(options = {}) {
    this.baseUrl = options.baseUrl || config.llm.baseUrl;
    this.model = options.model || config.llm.model;
    this.apiKey = options.apiKey !== undefined ? options.apiKey : config.llm.apiKey;
    this.timeoutMs = options.timeoutMs || config.llm.timeoutMs;
  }

  /**
   * Pings the endpoint to verify runtime availability and confirms the target model exists.
   * @returns {Promise<{ available: boolean, runtime?: string, model?: string, error?: string }>}
   */
  async checkAvailability() {
    // 1. Try Ollama native endpoint (/api/tags)
    try {
      const url = `${this.baseUrl.replace(/\/v1\/?$/, '')}/api/tags`;
      const res = await fetch(url, {
        signal: AbortSignal.timeout(4000)
      });
      if (res.ok) {
        const data = await res.json();
        const found = data.models?.find(m => m.name === this.model || m.name === `${this.model}:latest` || m.model === this.model);
        return {
          available: !!found,
          runtime: 'ollama',
          model: this.model,
          error: found ? undefined : `Model '${this.model}' not found in Ollama library`
        };
      }
    } catch (_) {}

    // 2. Try OpenAI-compatible endpoint (/v1/models or /models)
    try {
      const url = this.baseUrl.endsWith('/v1') ? `${this.baseUrl}/models` : `${this.baseUrl}/v1/models`;
      const headers = { 'Content-Type': 'application/json' };
      if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;

      const res = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(4000)
      });
      if (res.ok) {
        const data = await res.json();
        const found = data.data?.find(m => m.id === this.model || m.id.includes(this.model));
        return {
          available: true,
          runtime: 'openai-compatible',
          model: this.model,
          warning: found ? undefined : `Model '${this.model}' not explicitly listed, but endpoint is active`
        };
      }
    } catch (_) {}

    return {
      available: false,
      error: `Could not connect to LLM endpoint at ${this.baseUrl}`
    };
  }

  /**
   * Generates a structured JSON completion from messages.
   * @param {Array<{ role: string, content: string }>} messages
   * @param {Object} [options]
   * @returns {Promise<{ success: boolean, content?: Object, raw?: string, latencyMs: number, error?: string }>}
   */
  async chatJSON(messages, options = {}) {
    const startTime = Date.now();
    const timeout = options.timeoutMs || this.timeoutMs;

    // First attempt: Ollama native endpoint (/api/chat)
    try {
      const ollamaUrl = `${this.baseUrl.replace(/\/v1\/?$/, '')}/api/chat`;
      const response = await fetch(ollamaUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          messages,
          format: 'json',
          stream: false,
          options: {
            temperature: options.temperature !== undefined ? options.temperature : 0.2
          }
        }),
        signal: AbortSignal.timeout(timeout)
      });

      if (response.ok) {
        const json = await response.json();
        const rawContent = json.message?.content || '';
        const parsed = JSON.parse(rawContent);
        return {
          success: true,
          content: parsed,
          raw: rawContent,
          latencyMs: Date.now() - startTime
        };
      }
    } catch (err) {
      // If error was JSON parse failure, return raw content
      if (err instanceof SyntaxError) {
        return {
          success: false,
          error: 'MODEL_MALFORMED_JSON',
          latencyMs: Date.now() - startTime
        };
      }
    }

    // Second attempt: Standard OpenAI-compatible endpoint (/v1/chat/completions)
    try {
      const openAiUrl = this.baseUrl.endsWith('/v1') 
        ? `${this.baseUrl}/chat/completions` 
        : `${this.baseUrl}/v1/chat/completions`;
      
      const headers = { 'Content-Type': 'application/json' };
      if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;

      const response = await fetch(openAiUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: this.model,
          messages,
          response_format: { type: 'json_object' },
          temperature: options.temperature !== undefined ? options.temperature : 0.2
        }),
        signal: AbortSignal.timeout(timeout)
      });

      if (response.ok) {
        const json = await response.json();
        const rawContent = json.choices?.[0]?.message?.content || '';
        const parsed = JSON.parse(rawContent);
        return {
          success: true,
          content: parsed,
          raw: rawContent,
          latencyMs: Date.now() - startTime
        };
      } else {
        const errText = await response.text();
        return {
          success: false,
          error: `HTTP ${response.status}: ${errText}`,
          latencyMs: Date.now() - startTime
        };
      }
    } catch (err) {
      return {
        success: false,
        error: err.message,
        latencyMs: Date.now() - startTime
      };
    }
  }
}

export const defaultLLMClient = new LLMClient();
export default defaultLLMClient;
