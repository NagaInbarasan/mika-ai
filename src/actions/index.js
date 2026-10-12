import { executeLookAround } from './look.js';
import { executeInspectInventory } from './inventory.js';
import { executeNavigateTo } from './navigation.js';
import { executeCollectResource } from './resources.js';
import { executeEatFood } from './food.js';
import { executeCraftItem } from './crafting.js';
import { executePlaceBlock } from './build.js';
import { executeStoreInChest } from './storage.js';
import { executeFarmCrop } from './farming.js';
import { executeDropItem } from './drop.js';
import { executeAssistTeammate } from './assist.js';
import {
  executeAttackTarget,
  executeDefendWithShield,
  executeRetreatAndHeal,
  executeEquipGear
} from '../combat/index.js';
import { evaluateOutcome } from '../evaluation/outcome.js';
import { collectObservation } from '../minecraft/observe.js';

export const ALLOWED_ACTIONS = [
  'look_around',
  'inspect_inventory',
  'navigate_to',
  'collect_resource',
  'eat_food',
  'craft_item',
  'place_block',
  'attack_target',
  'defend_with_shield',
  'retreat_and_heal',
  'equip_gear',
  'store_in_chest',
  'farm_crop',
  'drop_item',
  'assist_teammate',
  'stop'
];

/**
 * Validates action proposal against strict allowlist and argument constraints.
 * @param {string} action
 * @param {Object} args
 * @returns {{ valid: boolean, error?: string }}
 */
export function validateAction(action, args = {}) {
  if (!ALLOWED_ACTIONS.includes(action)) {
    return {
      valid: false,
      error: `Unsupported action '${action}'. Allowed: ${ALLOWED_ACTIONS.join(', ')}`
    };
  }

  if (action === 'navigate_to') {
    if (args.x === undefined || args.z === undefined) {
      return { valid: false, error: "Action 'navigate_to' requires numeric 'x' and 'z' coordinates" };
    }
    if (isNaN(Number(args.x)) || isNaN(Number(args.z))) {
      return { valid: false, error: "'x' and 'z' coordinates must be numbers" };
    }
  }

  if (action === 'collect_resource' && !args.resource) {
    return { valid: false, error: "Action 'collect_resource' requires a 'resource' string argument" };
  }

  if (action === 'craft_item' && !args.item) {
    return { valid: false, error: "Action 'craft_item' requires an 'item' string argument" };
  }

  if (action === 'place_block' && !args.block && !args.item) {
    return { valid: false, error: "Action 'place_block' requires a 'block' or 'item' string argument" };
  }

  if (action === 'drop_item' && !args.item) {
    return { valid: false, error: "Action 'drop_item' requires an 'item' string argument" };
  }

  if (action === 'assist_teammate' && !args.teammate) {
    return { valid: false, error: "Action 'assist_teammate' requires a 'teammate' string argument" };
  }

  return { valid: true };
}

/**
 * Action Executor manages deterministic execution, timeouts, cancellation,
 * pre/post observation capture, and outcome verification.
 */
export class ActionExecutor {
  constructor(bot) {
    this.bot = bot;
    this.currentAction = null;
    this.currentAbortController = null;
  }

  /**
   * Immediately stops any ongoing action and halts pathfinding.
   */
  stop(reason = 'Manual stop requested') {
    console.log(`[Actions] Immediate stop triggered: ${reason}`);
    if (this.bot.pathfinder) {
      try {
        this.bot.pathfinder.stop();
      } catch (_) {}
    }

    if (this.currentAbortController) {
      this.currentAbortController.abort();
      this.currentAbortController = null;
    }

    this.bot.currentTask = 'idle';
    this.bot.recentActionStatus = 'stopped';
    this.currentAction = null;

    return {
      status: 'success',
      action: 'stop',
      message: `Halted current task: ${reason}`
    };
  }

  /**
   * Executes a validated action, capturing pre/post observations and computing outcome deltas.
   * @param {Object} params
   * @param {string} params.action - Action name
   * @param {Object} [params.args={}] - Arguments
   * @param {string} [params.expectedOutcome] - Expected outcome string
   * @param {string} [params.goal='execute action'] - Current high-level goal
   * @param {number} [params.timeout_ms] - Override timeout
   * @returns {Promise<Object>} Complete execution and outcome record
   */
  async execute({ action, args = {}, expectedOutcome = null, goal = 'execute action', timeout_ms = 30000 }) {
    // 1. Validation against allowlist
    const validation = validateAction(action, args);
    if (!validation.valid) {
      const failedResult = {
        status: 'failed',
        error_code: 'INVALID_ACTION',
        error: validation.error,
        duration_ms: 0
      };

      if (this.bot.recorder) {
        this.bot.recorder.recordExperience({
          minecraft_version: this.bot.version,
          goal,
          available_actions: ALLOWED_ACTIONS,
          decision: { action, arguments: args, expected_outcome: expectedOutcome },
          execution: failedResult,
          outcome: { task_progress: 0, reward: -0.5 },
          learning: { failure_detected: true, failure_category: 'invalid_action' }
        });
      }

      return { execution: failedResult, outcome: null };
    }

    // 2. Handle immediate stop action directly
    if (action === 'stop') {
      const stopResult = this.stop(args.reason || 'Stop action requested');
      return { execution: stopResult, outcome: { task_progress: 1, reward: 0 } };
    }

    // 3. Pre-action observation snapshot
    const preObservation = collectObservation(this.bot);
    const startTime = Date.now();

    this.bot.currentTask = `${action}:${JSON.stringify(args)}`;
    this.currentAction = action;
    const abortController = new AbortController();
    this.currentAbortController = abortController;

    console.log(`[Actions] Executing '${action}' with args:`, JSON.stringify(args));

    // 4. Action Dispatch with timeout race
    let executionResult;
    try {
      const actionPromise = this._dispatchAction(action, args);
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error(`Action '${action}' exceeded timeout limit of ${timeout_ms}ms`)), timeout_ms);
      });

      executionResult = await Promise.race([actionPromise, timeoutPromise]);
      executionResult.duration_ms = Date.now() - startTime;
    } catch (err) {
      const isTimeout = err.message && err.message.includes('timeout');
      executionResult = {
        status: isTimeout ? 'timeout' : 'failed',
        error_code: isTimeout ? 'TIMEOUT_EXCEEDED' : 'EXECUTION_EXCEPTION',
        error: err.message,
        duration_ms: Date.now() - startTime
      };
      this.stop(`Error or timeout in ${action}`);
    } finally {
      this.currentAbortController = null;
      this.currentAction = null;
    }

    // 5. Post-action observation snapshot
    const postObservation = collectObservation(this.bot);

    // 6. Outcome evaluation and measurable deltas
    const outcome = evaluateOutcome({
      preObservation,
      postObservation,
      action,
      args,
      expectedOutcome,
      executionResult
    });

    this.bot.recentActionStatus = executionResult.status;

    // 7. Structured Experience Logging (Section 5 Schema)
    if (this.bot.recorder) {
      const loggedEvent = this.bot.recorder.recordExperience({
        minecraft_version: this.bot.version,
        dimension: preObservation.environment ? preObservation.environment.dimension : 'overworld',
        observation_before: preObservation,
        goal,
        available_actions: ALLOWED_ACTIONS,
        decision: {
          action,
          arguments: args,
          reason_summary: `Executed deterministic action ${action}`,
          expected_outcome: expectedOutcome,
          risk: 'low',
          confidence: 1.0
        },
        execution: executionResult,
        observation_after: postObservation,
        outcome,
        learning: {
          failure_detected: executionResult.status !== 'success',
          failure_category: executionResult.status !== 'success' ? (executionResult.error_code || 'execution_error') : null,
          feedback_event_ids: [],
          correction_applied: false,
          correction_verified: null
        }
      });
      this.bot.lastEventId = loggedEvent.event_id;
    }

    console.log(`[Actions] '${action}' finished with status: ${executionResult.status} (${executionResult.duration_ms}ms, progress: ${outcome.task_progress})`);

    return {
      execution: executionResult,
      outcome,
      preObservation,
      postObservation
    };
  }

  async _dispatchAction(action, args) {
    switch (action) {
      case 'look_around':
        return await executeLookAround(this.bot, args);
      case 'inspect_inventory':
        return await executeInspectInventory(this.bot, args);
      case 'navigate_to':
        return await executeNavigateTo(this.bot, args);
      case 'collect_resource':
        return await executeCollectResource(this.bot, args);
      case 'eat_food':
        return await executeEatFood(this.bot, args);
      case 'craft_item':
        return await executeCraftItem(this.bot, args);
      case 'place_block':
        return await executePlaceBlock(this.bot, args);
      case 'attack_target':
        return await executeAttackTarget(this.bot, args);
      case 'defend_with_shield':
        return await executeDefendWithShield(this.bot, args);
      case 'retreat_and_heal':
        return await executeRetreatAndHeal(this.bot, args);
      case 'equip_gear':
        return await executeEquipGear(this.bot, args);
      case 'store_in_chest':
        return await executeStoreInChest(this.bot, args);
      case 'farm_crop':
        return await executeFarmCrop(this.bot, args);
      case 'drop_item':
        return await executeDropItem(this.bot, args);
      case 'assist_teammate':
        return await executeAssistTeammate(this.bot, args);
      default:
        throw new Error(`Unhandled action '${action}'`);
    }
  }
}

export default ActionExecutor;
