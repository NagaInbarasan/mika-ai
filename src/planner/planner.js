import defaultLLMClient from './llm-client.js';
import { buildReasoningContext } from './context.js';
import { validateDecision } from './action-schema.js';

export class HighLevelPlanner {
  constructor(options = {}) {
    this.llmClient = options.llmClient || defaultLLMClient;
    this.maxRetries = options.maxRetries || 1;
    this.modelId = options.modelId || 'qwen3.5:9b';
  }

  /**
   * Fast safety check to prioritize immediate mortal threats before waiting on LLM inference.
   * @param {Object} observation
   * @returns {Object|null} Immediate reactive action or null
   */
  checkImmediateThreats(observation) {
    if (!observation || !observation.agent) return null;

    const threats = observation.nearby_threats || [];
    const health = observation.agent.health;

    // Critical danger: hostile mob within 4.5 blocks
    const closeThreat = threats.find(t => t.distance <= 4.5);
    if (closeThreat && health <= 10) {
      console.warn(`[Planner Safety] Immediate threat detected: ${closeThreat.name} at ${closeThreat.distance}m!`);
      // Retreat backwards away from threat
      const botPos = observation.agent.position;
      const retreatX = Math.round(botPos.x + (botPos.x - closeThreat.position.x) * 2);
      const retreatZ = Math.round(botPos.z + (botPos.z - closeThreat.position.z) * 2);
      return {
        goal: 'emergency retreat from hostile threat',
        reason_summary: `Hostile ${closeThreat.name} is within ${closeThreat.distance}m and health is low (${health}/20)`,
        action: 'navigate_to',
        arguments: { x: retreatX, z: retreatZ, range: 2.0 },
        expected_outcome: 'distance to threat increases',
        risk: 'high',
        confidence: 0.95
      };
    }

    return null;
  }

  /**
   * Proposes the next structured action using Qwen 3.5 9B with validation and retry.
   * @param {Object} params
   * @param {Object} params.observation - Current world snapshot
   * @param {string} [params.goal] - Objective
   * @param {Object} [params.previousOutcome] - Result of last step
   * @param {Array} [params.memories] - Past mistake/skill memories
   * @returns {Promise<{ success: boolean, decision: Object, latencyMs: number, error?: string }>}
   */
  async planNextStep({ observation, goal = 'survive and explore', previousOutcome = null, memories = [], memoryStore = null }) {
    // 1. Reactive safety priority
    const reactiveDecision = this.checkImmediateThreats(observation);
    if (reactiveDecision) {
      return {
        success: true,
        decision: reactiveDecision,
        latencyMs: 0,
        source: 'safety_override'
      };
    }

    // 2. Build context
    const context = buildReasoningContext({ observation, goal, previousOutcome, memories, memoryStore });

    const systemPrompt = `You are MIKA, an autonomous Minecraft survival AI agent.
Your primary survival instinct is governed by 3 CORE SURVIVAL RULES:
1. COLLECT LOGS EARLY: Wood/logs are the vital prerequisite for crafting tools, weapons, and shelter. Gather logs or sticks during morning/midday.
2. MAINTAIN FOOD & HEALTH: Never allow starvation. Eat when food < 18 if you have food; locate food if hungry and out of food.
3. BUILD SHELTER BEFORE NIGHT: Daylight lasts until tick 12000. Lethal hostile mobs spawn at night (tick 13000). When afternoon arrives (tick 9000+), STOP wandering, gather building blocks, and construct or enter shelter before darkness falls. Stay inside shelter at night!

You make high-level decisions to accomplish goals safely and efficiently.
You MUST output ONLY a valid JSON object matching this exact structure:
{
  "goal": "string (the immediate objective)",
  "reason_summary": "string (concise reason based on observation and survival rules)",
  "action": "look_around" | "inspect_inventory" | "navigate_to" | "collect_resource" | "eat_food" | "craft_item" | "place_block" | "stop",
  "arguments": { ... },
  "expected_outcome": "string (what should measurably change in inventory or state)",
  "risk": "low" | "medium" | "high",
  "confidence": number (0.0 to 1.0)
}
Strict rules:
1. Select an action ONLY from the allowed_actions list.
2. Respect the active survival_directives provided in your context.
3. For 'collect_resource', pick a resource that actually appears in nearby_resources or environment.
4. For 'navigate_to', provide valid numeric x and z coordinates.
5. For 'eat_food', use when health < 20 or food < 20 and food exists in inventory.
6. For 'place_block', specify 'block' from inventory (e.g. dirt, sand, cobblestone, oak_planks).
7. If night falls or hostile danger threatens, prioritize shelter/defense over exploration.
8. If a 'proven_strategy' is present in context, you may either replicate it for reliable success OR propose an improved, more optimal action (e.g. upgraded tool or batching).
9. If no safe action is possible, select 'stop'.`;

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: JSON.stringify(context, null, 2) }
    ];

    let lastError = null;

    // Attempt generation with bounded retry
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) {
        messages.push({
          role: 'user',
          content: `Your previous response failed validation: ${lastError}. Correct your output and return strictly valid JSON matching the schema.`
        });
      }

      console.log(`[Planner] Requesting plan from Qwen 3.5 9B (Attempt ${attempt + 1}/${this.maxRetries + 1})...`);
      const llmResult = await this.llmClient.chatJSON(messages);

      if (!llmResult.success) {
        lastError = llmResult.error || 'LLM communication failure';
        continue;
      }

      const validation = validateDecision(llmResult.content);
      if (validation.valid) {
        return {
          success: true,
          decision: validation.decision,
          latencyMs: llmResult.latencyMs,
          source: 'qwen'
        };
      }

      lastError = validation.error;
      console.warn(`[Planner] Qwen response validation failed:`, lastError);
    }

    // Safe fallback if Qwen is offline or repeatedly invalid
    console.warn(`[Planner] Falling back to safe idle state due to: ${lastError}`);
    return {
      success: false,
      error: lastError,
      decision: {
        goal: 'safe idle fallback',
        reason_summary: `LLM decision unavailable or rejected: ${lastError}`,
        action: 'stop',
        arguments: { reason: 'LLM decision failure' },
        expected_outcome: 'bot remains safe and idle',
        risk: 'low',
        confidence: 0.5
      },
      latencyMs: 0,
      source: 'fallback'
    };
  }
}

export const defaultPlanner = new HighLevelPlanner();
export default defaultPlanner;
