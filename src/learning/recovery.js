import defaultMemoryStore from './memory.js';
import { detectMistake } from './mistake-detector.js';
import defaultLLMClient from '../planner/llm-client.js';
import { validateDecision } from '../planner/action-schema.js';
import { ALLOWED_ACTIONS } from '../actions/index.js';

export class RecoveryManager {
  constructor(options = {}) {
    this.memoryStore = options.memoryStore || defaultMemoryStore;
    this.llmClient = options.llmClient || defaultLLMClient;
    this.maxRecoveryRetries = options.maxRecoveryRetries || 1;
  }

  /**
   * Attempts a bounded, validated recovery when an action execution fails.
   * @param {Object} params
   * @param {import('mineflayer').Bot} params.bot
   * @param {Object} params.failedStep - { action, args, execution, outcome, observationBefore, eventId }
   * @param {string} [params.goal] - High level objective
   * @returns {Promise<{ recovered: boolean, correction: Object, retryResult?: Object }>}
   */
  async attemptRecovery({ bot, failedStep, goal = 'recover from failure' }) {
    // Step 1: Detect and classify the failure
    const mistake = detectMistake({
      action: failedStep.action,
      args: failedStep.args,
      execution: failedStep.execution,
      outcome: failedStep.outcome,
      observationBefore: failedStep.observationBefore,
      observationAfter: bot.collectObservation ? bot.collectObservation(bot) : {}
    });

    if (!mistake.failure_detected) {
      return { recovered: false, error: 'No failure detected to recover from' };
    }

    console.log(`[Recovery] Failure classified: [${mistake.failure_category}] "${mistake.observed_evidence}" (Pattern: ${mistake.situation_pattern})`);

    // Step 2: Check persistent memory for an existing validated correction
    const existingMemories = this.memoryStore.findRelevantMemories(mistake.situation_pattern);
    let proposedCorrection = null;
    let memoryUsed = null;

    if (existingMemories.length > 0 && existingMemories[0].validated_correction) {
      memoryUsed = existingMemories[0];
      proposedCorrection = memoryUsed.validated_correction;
      console.log(`[Recovery] Retrieved validated correction from persistent memory (Confidence: ${memoryUsed.confidence}):`, JSON.stringify(proposedCorrection));
    } else {
      // Step 2b: Check deterministic recovery rules
      const deterministicRule = this.getDeterministicRecoveryRule(
        mistake,
        failedStep,
        bot.collectObservation ? bot.collectObservation(bot) : {}
      );

      if (deterministicRule) {
        proposedCorrection = deterministicRule;
        console.log(`[Recovery] Applying deterministic recovery rule for [${mistake.failure_category}]:`, JSON.stringify(proposedCorrection));
      } else {
        // Step 3: Ask Qwen for a recovery hypothesis if no rule exists
        proposedCorrection = await this._consultQwenForRecovery({
          mistake,
          failedStep,
          observation: bot.collectObservation ? bot.collectObservation(bot) : {}
        });
      }
    }

    if (!proposedCorrection) {
      console.warn(`[Recovery] No recovery proposal could be formed. Safely stopping.`);
      return { recovered: false, mistake, error: 'No valid recovery proposal' };
    }

    // Step 4: Validate proposed correction against safety allowlist and schemas
    const decisionValidation = validateDecision(proposedCorrection);
    if (!decisionValidation.valid) {
      console.warn(`[Recovery] Proposed recovery failed validation: ${decisionValidation.error}`);
      return { recovered: false, mistake, error: decisionValidation.error };
    }

    const validAction = decisionValidation.decision;

    // Step 5: Execute the bounded recovery action
    console.log(`[Recovery] Executing recovery action: ${validAction.action} with args:`, JSON.stringify(validAction.arguments));
    if (bot.chat) {
      bot.chat(`[Recovery] Attempting fix: ${validAction.action} (${validAction.reason_summary || 'recovering'})`);
    }

    const retryResult = await bot.actions.execute({
      action: validAction.action,
      args: validAction.arguments,
      goal: `recover: ${validAction.goal || mistake.situation_pattern}`,
      expectedOutcome: validAction.expected_outcome
    });

    const isRecovered = retryResult.execution.status === 'success';

    // Step 6: Update persistent memory store
    this.memoryStore.addOrUpdateCorrection({
      situationPattern: mistake.situation_pattern,
      failureCategory: mistake.failure_category,
      evidence: mistake.observed_evidence,
      correction: validAction,
      wasSuccessful: isRecovered
    });

    // Step 7: Record linked correction event in feedback.jsonl (Section 5 Schema)
    if (bot.recorder) {
      bot.recorder.recordFeedback({
        event_type: 'correction',
        related_event_id: failedStep.eventId || null,
        failure_category: mistake.failure_category,
        observed_evidence: mistake.observed_evidence,
        previous_action: failedStep.action,
        correction_proposed: validAction.action,
        retry_result: retryResult.execution.status,
        memory_update: isRecovered ? `Validated correction for ${mistake.situation_pattern}` : `Recovery attempt failed`
      });
    }

    console.log(`[Recovery] Result: ${isRecovered ? 'SUCCESS (learned and persisted)' : 'FAILED (downgraded)'}`);

    return {
      recovered: isRecovered,
      mistake,
      correction: validAction,
      retryResult,
      memoryUsed
    };
  }

  async _consultQwenForRecovery({ mistake, failedStep, observation }) {
    const prompt = [
      {
        role: 'system',
        content: `You are MIKA, an AI bot recovery system.
An action has just failed. You must diagnose the failure from the evidence and propose ONE recovery action strictly from: ${ALLOWED_ACTIONS.join(', ')}.
Respond strictly in JSON matching this schema:
{
  "goal": "string",
  "reason_summary": "concise explanation of why this fixes the issue",
  "action": "one of allowed actions",
  "arguments": {},
  "expected_outcome": "string",
  "risk": "low" | "medium" | "high",
  "confidence": number
}`
      },
      {
        role: 'user',
        content: JSON.stringify({
          failed_action: failedStep.action,
          failed_arguments: failedStep.args,
          failure_category: mistake.failure_category,
          observed_evidence: mistake.observed_evidence,
          current_inventory: observation.inventory || [],
          nearby_resources: observation.nearby_resources || []
        }, null, 2)
      }
    ];

    try {
      const res = await this.llmClient.chatJSON(prompt, { timeoutMs: 25000 });
      if (res.success && res.content) {
        return res.content;
      }
    } catch (_) {}

    // Deterministic fallback proposals based on failure category
    const deterministic = this.getDeterministicRecoveryRule(mistake, failedStep, observation);
    if (deterministic) {
      return deterministic;
    }

    return {
      goal: 'halt after failure',
      reason_summary: 'Stop and stabilize state',
      action: 'stop',
      arguments: {},
      expected_outcome: 'bot remains safe',
      risk: 'low',
      confidence: 0.7
    };
  }

  /**
   * Deterministic recovery rule engine mapping classified failures to safe, verified actions.
   * @param {Object} mistake 
   * @param {Object} failedStep 
   * @param {Object} [observation={}]
   * @returns {Object|null}
   */
  getDeterministicRecoveryRule(mistake, failedStep, observation = {}) {
    const cat = mistake.failure_category;
    const errCode = mistake.error_code || '';

    if (cat === 'missing_prerequisite') {
      return {
        goal: 'inspect inventory to verify missing items',
        reason_summary: 'Verify current items before repeating recipe',
        action: 'inspect_inventory',
        arguments: {},
        expected_outcome: 'inventory state refreshed',
        risk: 'low',
        confidence: 0.85
      };
    }

    if (cat === 'navigation' || errCode.includes('UNREACHABLE') || errCode.includes('PATHFINDER')) {
      return {
        goal: 'look around to assess pathing obstacles',
        reason_summary: 'Target unreachable; surveying surroundings to clear path',
        action: 'look_around',
        arguments: {},
        expected_outcome: 'bot surveys surroundings',
        risk: 'low',
        confidence: 0.8
      };
    }

    if (cat === 'threat_response' || errCode.includes('THREAT')) {
      const hp = observation.agent?.health ?? 20;
      const food = observation.agent?.food ?? 20;
      if (hp <= 10 && food < 20) {
        return {
          goal: 'eat food to recover health under threat',
          reason_summary: 'Health critical under hostile threat; consuming food',
          action: 'eat_food',
          arguments: {},
          expected_outcome: 'health and food levels increase',
          risk: 'medium',
          confidence: 0.85
        };
      }
      return {
        goal: 'look around and identify safe retreat route',
        reason_summary: 'Threat detected; locating safe terrain',
        action: 'look_around',
        arguments: {},
        expected_outcome: 'threat position identified',
        risk: 'low',
        confidence: 0.8
      };
    }

    if (cat === 'resource_planning' || errCode.includes('NOT_FOUND')) {
      return {
        goal: 'search for required resource in wider area',
        reason_summary: 'Resource not in immediate vicinity; surveying area',
        action: 'look_around',
        arguments: {},
        expected_outcome: 'new resource blocks surveyed',
        risk: 'low',
        confidence: 0.75
      };
    }

    if (cat === 'timeout') {
      return {
        goal: 'reset and re-orient after timeout',
        reason_summary: 'Previous step timed out; resetting state',
        action: 'look_around',
        arguments: {},
        expected_outcome: 'bot orientation refreshed',
        risk: 'low',
        confidence: 0.75
      };
    }

    if (cat === 'invalid_action') {
      return {
        goal: 'stabilize after invalid action',
        reason_summary: 'Action parameters were rejected; stabilizing',
        action: 'stop',
        arguments: {},
        expected_outcome: 'bot idle safely',
        risk: 'low',
        confidence: 0.9
      };
    }

    return null;
  }
}

export const defaultRecoveryManager = new RecoveryManager();
export default defaultRecoveryManager;
