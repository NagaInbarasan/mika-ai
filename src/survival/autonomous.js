import { selectContextualGoal, GoalExecutionTracker } from './priority.js';
import { resolveGoalPlan, GOAL_DEFINITIONS } from '../learning/goals.js';
import { evaluateGoalOutcome } from '../learning/evaluate.js';
import defaultShelterManager from './shelter.js';
import { defaultProgression } from '../progression/state-machine.js';
import defaultAdaptiveThinking from '../learning/adaptive-thinking.js';

/**
 * Autonomous Survival Loop Controller.
 * Drives MIKA through continuous first-principles survival cycles:
 * Observe -> Prioritize -> Plan -> Act -> Verify -> Learn.
 */
export class AutonomousSurvivalController {
  constructor(options = {}) {
    this.tracker = new GoalExecutionTracker(3);
    this.isRunning = false;
    this.currentStep = 0;
    this.maxSteps = options.maxSteps || 30;
    this.intervalMs = options.intervalMs || 2500;
  }

  /**
   * Starts the continuous autonomous survival loop.
   * @param {import('mineflayer').Bot} bot
   * @param {number} [maxSteps=30]
   * @param {boolean} [continuous=false]
   */
  async start(bot, maxSteps = 30, continuous = undefined) {
    if (this.isRunning) {
      if (typeof bot.chat === 'function') bot.chat('Autonomous survival loop is already running.');
      return;
    }

    this.isRunning = true;
    this.currentStep = 0;
    this.maxSteps = maxSteps || this.maxSteps || 30;
    if (continuous !== undefined) {
      this.continuous = continuous;
    }

    if (typeof bot.chat === 'function') {
      const modeDesc = continuous ? 'Continuous Data Gathering' : `Budget: ${maxSteps} steps`;
      bot.chat(`[Auto-Survival] Loop activated (${modeDesc}). Type "!stop" or "!auto off" to pause.`);
    }

    console.log(`[Auto-Survival] Starting autonomous loop (maxSteps: ${maxSteps}, continuous: ${continuous})`);

    while (this.isRunning && bot.isReady) {
      if (!this.continuous && this.currentStep >= this.maxSteps) {
        break;
      }
      this.currentStep++;
      console.log(`\n--- [Auto-Survival Cycle #${this.currentStep}${this.continuous ? '' : `/${this.maxSteps}`}] ---`);

      try {
        const stepResult = await this.runSingleStep(bot);
        if (!stepResult.continued) {
          if ((stepResult.reason === 'Bot entity not ready' || !bot.entity) && this.isRunning) {
            console.log('[Auto-Survival] Bot entity not ready (respawning or reloading). Waiting 3s...');
            await new Promise(r => setTimeout(r, 3000));
            continue;
          }
          console.log(`[Auto-Survival] Cycle concluded: ${stepResult.reason}`);
          break;
        }
      } catch (err) {
        console.error(`[Auto-Survival] Unexpected step error:`, err.message);
      }

      // Allow world physics, drop pickups, and server ticks to settle
      await new Promise(r => setTimeout(r, this.intervalMs));
    }

    const wasRunning = this.isRunning;
    this.isRunning = false;

    if (wasRunning && !this.continuous && this.currentStep >= this.maxSteps) {
      if (typeof bot.chat === 'function') {
        bot.chat(`[Auto-Survival] Completed step budget (${this.maxSteps} cycles). Bot resting in safe state.`);
      }
    }
  }

  /**
   * Stops the autonomous survival loop.
   * @param {import('mineflayer').Bot} [bot]
   */
  stop(bot = null) {
    if (this.isRunning) {
      this.isRunning = false;
      console.log('[Auto-Survival] Loop stopped.');
      if (bot && typeof bot.chat === 'function') {
        bot.chat('[Auto-Survival] Loop stopped. MIKA is now idle.');
      }
    }
  }

  /**
   * Executes a single complete survival step:
   * Observe -> Contextual Priority -> Action Dispatch -> Outcome Evaluation -> Learning Persistence.
   *
   * @param {import('mineflayer').Bot} bot
   * @returns {Promise<{ continued: boolean, reason: string, goalId?: string, actionResult?: Object }>}
   */
  async runSingleStep(bot) {
    if (!bot || !bot.entity) {
      return { continued: false, reason: 'Bot entity not ready' };
    }

    // 1. Observe world
    const preObs = typeof bot.collectObservation === 'function' ? bot.collectObservation(bot) : { agent: bot.entity };

    // 2. Select contextual priority goal
    const priority = selectContextualGoal(preObs, bot.memoryStore, this.tracker);
    const topGoalId = priority.goalId;
    bot.lastGoalId = topGoalId;

    console.log(`[Auto-Survival] Priority Tier ${priority.tier}: ${topGoalId} ("${priority.reason}")`);

    // 3. Resolve dependencies to pick the immediate executable step
    const plan = priority.plan && priority.plan.length > 0 ? priority.plan : resolveGoalPlan(topGoalId, preObs);
    const currentGoalId = plan[0] || topGoalId;

    if (typeof bot.chat === 'function') {
      bot.chat(`[Priority T${priority.tier}] Goal: ${currentGoalId}`);
    }

    // 3b. Adaptive Thinking: Query past task completion memory & cognitive improvement
    let adaptivePlan = null;
    try {
      if (defaultAdaptiveThinking) {
        adaptivePlan = await defaultAdaptiveThinking.evaluateStrategy({
          bot,
          goalId: currentGoalId,
          observation: preObs,
          memoryStore: bot.memoryStore,
          planner: bot.highLevelPlanner || null
        });

        if (adaptivePlan && adaptivePlan.mode !== 'first_exploration') {
          console.log(`[Adaptive-Thinking] Mode: ${adaptivePlan.mode} | ${adaptivePlan.rationale}`);
          if (typeof bot.chat === 'function') {
            if (adaptivePlan.mode === 'improved_thinking' || adaptivePlan.mode === 'improved_thinking_llm') {
              bot.chat(`[Thinking: Improved Method] ${adaptivePlan.rationale}`);
            } else if (adaptivePlan.mode === 'proven_memory') {
              bot.chat(`[Memory: Recalling Proven Method] ${adaptivePlan.strategy?.action} (${adaptivePlan.strategy?.best_duration_ms}ms)`);
            }
          }
        }
      }
    } catch (thinkErr) {
      console.warn(`[Adaptive-Thinking] Error evaluating strategy: ${thinkErr.message}`);
    }

    const stepStartTime = Date.now();

    // 4. Dispatch action for the goal (incorporating adaptive plan parameters)
    const execOutcome = await this.dispatchGoalAction(bot, currentGoalId, preObs, adaptivePlan);

    // 5. Post-action observation
    const postObs = typeof bot.collectObservation === 'function' ? bot.collectObservation(bot) : { agent: bot.entity };

    // 6. Evaluate physical outcome and learning
    const evaluation = evaluateGoalOutcome({
      goalId: currentGoalId,
      preObservation: preObs,
      postObservation: postObs,
      action: execOutcome.action,
      args: execOutcome.args,
      actionResult: execOutcome.result
    });

    // 7. Track retries to prevent infinite loops
    this.tracker.recordAttempt(currentGoalId, evaluation.goalAchieved, evaluation.completionReason);

    // 8. Persistent Task Strategy Learning & Evolution
    if (evaluation.goalAchieved && bot.memoryStore && typeof bot.memoryStore.recordTaskCompletion === 'function') {
      const completionDuration = execOutcome.result?.duration_ms || (Date.now() - stepStartTime);
      const completionResult = bot.memoryStore.recordTaskCompletion({
        goalId: currentGoalId,
        action: execOutcome.action,
        args: execOutcome.args,
        durationMs: completionDuration,
        preObservation: preObs,
        postObservation: postObs,
        improvementReason: (adaptivePlan && (adaptivePlan.mode === 'improved_thinking' || adaptivePlan.mode === 'improved_thinking_llm'))
          ? adaptivePlan.rationale
          : null
      });

      if (completionResult && completionResult.isImprovement) {
        console.log(`[Memory: Strategy Improved!] Goal '${currentGoalId}': ${completionResult.improvementNote}`);
        if (typeof bot.chat === 'function') {
          bot.chat(`[Memory: Improved Strategy] ${completionResult.improvementNote}`);
        }
      } else if (completionResult) {
        console.log(`[Memory: Task Recorded] Goal '${currentGoalId}' (Completions: ${completionResult.strategy.total_completions})`);
      }
    }

    // 9. Immutable Experience Recording
    if (bot.recorder && typeof bot.recorder.recordExperience === 'function') {
      const recordedExp = bot.recorder.recordExperience({
        goal: currentGoalId,
        action: execOutcome.action,
        args: execOutcome.args,
        reason_summary: priority.reason,
        observation_before: preObs,
        observation_after: postObs,
        result: evaluation
      });
      if (recordedExp && recordedExp.event_id) {
        bot.lastEventId = recordedExp.event_id;
      }
    }

    // 10. Persistent Mistake & Lesson Storage
    if (bot.memoryStore && typeof bot.memoryStore.storeSurvivalLesson === 'function') {
      bot.memoryStore.storeSurvivalLesson({
        goalId: currentGoalId,
        situationPattern: `${currentGoalId}:${execOutcome.action}`,
        failureCategory: evaluation.failureCategory,
        evidence: evaluation.completionReason,
        correction: evaluation.recommendedCorrection,
        wasSuccessful: evaluation.goalAchieved
      });
    }

    if (typeof bot.chat === 'function') {
      const statusIcon = evaluation.goalAchieved ? 'SUCCESS' : 'FAILED';
      bot.chat(`[Outcome: ${statusIcon}] ${evaluation.completionReason || execOutcome.action}`);
    }

    // 11. Progression Stage Evaluation and Promotion
    try {
      const advancement = defaultProgression.evaluateAdvancement(postObs);
      if (advancement && advancement.canAdvance) {
        defaultProgression.advanceStage(postObs, bot);
      }
    } catch (_) { }

    return {
      continued: this.isRunning,
      reason: evaluation.completionReason,
      goalId: currentGoalId,
      actionResult: execOutcome.result,
      evaluation
    };
  }

  /**
   * Dispatches the corresponding action for a goal.
   * @param {import('mineflayer').Bot} bot
   * @param {string} goalId
   * @param {Object} obs
   * @param {Object} [adaptivePlan=null]
   * @returns {Promise<{ action: string, args: Object, result: Object }>}
   */
  async dispatchGoalAction(bot, goalId, obs, adaptivePlan = null) {
    const goalDef = GOAL_DEFINITIONS[goalId];

    // Check if an LLM proposed a novel action that can be dispatched
    if (adaptivePlan && adaptivePlan.mode === 'improved_thinking_llm' && adaptivePlan.proposedAction && bot.actions?.allowedActions?.includes(adaptivePlan.proposedAction)) {
      try {
        const res = await bot.actions.execute({
          action: adaptivePlan.proposedAction,
          args: adaptivePlan.proposedArgs || {},
          goal: `LLM improved action for ${goalId}`
        });
        return {
          action: adaptivePlan.proposedAction,
          args: adaptivePlan.proposedArgs || {},
          result: res.execution
        };
      } catch (llmErr) {
        console.warn(`[Auto-Survival] LLM action execution fallback: ${llmErr.message}`);
      }
    }

    switch (goalId) {
      case 'SURVIVE_IMMEDIATE_THREAT': {
        const res = await bot.actions.execute({
          action: 'retreat_and_heal',
          goal: 'tactical retreat from hostile danger'
        });
        return { action: 'retreat_and_heal', args: {}, result: res.execution };
      }

      case 'RETURN_TO_SHELTER_BASE': {
        const base = obs?.known_locations?.shelter_base || (bot.memoryStore && typeof bot.memoryStore.getLocation === 'function' ? bot.memoryStore.getLocation('shelter') : null);
        if (base && base.position) {
          const res = await bot.actions.execute({
            action: 'navigate_to',
            args: { x: base.position.x, y: base.position.y, z: base.position.z, range: 2.0 },
            goal: 'return to remembered shelter base'
          });
          return { action: 'navigate_to', args: { x: base.position.x, y: base.position.y, z: base.position.z }, result: res.execution };
        }
        const shelterRes = await defaultShelterManager.buildEmergencyShelter(bot);
        return { action: 'build_shelter', args: {}, result: shelterRes };
      }

      case 'RECOVER_LOST_ITEMS': {
        const lost = obs?.known_locations?.lost_things || (bot.memoryStore && typeof bot.memoryStore.getLostThingsLocation === 'function' ? bot.memoryStore.getLostThingsLocation() : null);
        if (lost && lost.position) {
          const res = await bot.actions.execute({
            action: 'navigate_to',
            args: { x: lost.position.x, y: lost.position.y, z: lost.position.z, range: 1.5 },
            goal: 'navigate to death location to recover lost items'
          });
          if (res.execution.status === 'success' && bot.memoryStore) {
            bot.memoryStore.clearLostThings();
          }
          return { action: 'navigate_to', args: { x: lost.position.x, y: lost.position.y, z: lost.position.z }, result: res.execution };
        }
        return { action: 'inspect_inventory', args: {}, result: { status: 'failed', error: 'No lost things location found' } };
      }

      case 'BUILD_EMERGENCY_SHELTER': {
        const shelterRes = await defaultShelterManager.buildEmergencyShelter(bot);
        return { action: 'build_shelter', args: {}, result: shelterRes };
      }

      case 'GATHER_SHELTER_BLOCKS': {
        const res = await bot.actions.execute({
          action: 'collect_resource',
          args: { resource: 'dirt', count: 4 },
          goal: 'gather dirt blocks for emergency shelter'
        });
        return { action: 'collect_resource', args: { resource: 'dirt' }, result: res.execution };
      }

      case 'GATHER_WOOD_LOGS': {
        const count = adaptivePlan?.proposedArgs?.count || 3;
        const preferredTool = adaptivePlan?.proposedArgs?.preferred_tool || null;
        const args = { resource: 'wood', count, ...(preferredTool ? { preferred_tool: preferredTool } : {}) };
        const res = await bot.actions.execute({
          action: 'collect_resource',
          args,
          goal: 'harvest tree for wood logs'
        });
        return { action: 'collect_resource', args, result: res.execution };
      }

      case 'CRAFT_PLANKS': {
        const count = adaptivePlan?.proposedArgs?.count || 2;
        const args = { item: 'planks', count };
        const res = await bot.actions.execute({
          action: 'craft_item',
          args,
          goal: 'craft planks from logs'
        });
        return { action: 'craft_item', args, result: res.execution };
      }

      case 'CRAFT_STICKS': {
        const count = adaptivePlan?.proposedArgs?.count || 1;
        const args = { item: 'stick', count };
        const res = await bot.actions.execute({
          action: 'craft_item',
          args,
          goal: 'craft sticks for tools'
        });
        return { action: 'craft_item', args, result: res.execution };
      }

      case 'CRAFT_CRAFTING_TABLE': {
        const res = await bot.actions.execute({
          action: 'craft_item',
          args: { item: 'crafting_table', count: 1 },
          goal: 'craft crafting table'
        });
        return { action: 'craft_item', args: { item: 'crafting_table' }, result: res.execution };
      }

      case 'CRAFT_WOODEN_PICKAXE': {
        const res = await bot.actions.execute({
          action: 'craft_item',
          args: { item: 'wooden_pickaxe', count: 1 },
          goal: 'craft wooden pickaxe'
        });
        return { action: 'craft_item', args: { item: 'wooden_pickaxe' }, result: res.execution };
      }

      case 'MINE_STONE': {
        const count = adaptivePlan?.proposedArgs?.count || 3;
        const preferredTool = adaptivePlan?.proposedArgs?.preferred_tool || null;
        const args = { resource: 'stone', count, ...(preferredTool ? { preferred_tool: preferredTool } : {}) };
        const res = await bot.actions.execute({
          action: 'collect_resource',
          args,
          goal: 'mine stone using pickaxe to collect cobblestone'
        });
        return { action: 'collect_resource', args, result: res.execution };
      }

      case 'CRAFT_STONE_TOOLS': {
        const res = await bot.actions.execute({
          action: 'craft_item',
          args: { item: 'stone_pickaxe', count: 1 },
          goal: 'craft stone pickaxe'
        });
        return { action: 'craft_item', args: { item: 'stone_pickaxe' }, result: res.execution };
      }

      case 'CRAFT_STONE_SWORD': {
        const res = await bot.actions.execute({
          action: 'craft_item',
          args: { item: 'stone_sword', count: 1 },
          goal: 'craft stone sword'
        });
        return { action: 'craft_item', args: { item: 'stone_sword' }, result: res.execution };
      }

      case 'CRAFT_STONE_AXE': {
        const res = await bot.actions.execute({
          action: 'craft_item',
          args: { item: 'stone_axe', count: 1 },
          goal: 'craft stone axe'
        });
        return { action: 'craft_item', args: { item: 'stone_axe' }, result: res.execution };
      }

      case 'CRAFT_FURNACE': {
        const res = await bot.actions.execute({
          action: 'craft_item',
          args: { item: 'furnace', count: 1 },
          goal: 'craft furnace'
        });
        return { action: 'craft_item', args: { item: 'furnace' }, result: res.execution };
      }

      case 'CRAFT_CHEST': {
        const res = await bot.actions.execute({
          action: 'craft_item',
          args: { item: 'chest', count: 1 },
          goal: 'craft chest'
        });
        return { action: 'craft_item', args: { item: 'chest' }, result: res.execution };
      }

      case 'CRAFT_SHIELD': {
        const res = await bot.actions.execute({
          action: 'craft_item',
          args: { item: 'shield', count: 1 },
          goal: 'craft shield'
        });
        return { action: 'craft_item', args: { item: 'shield' }, result: res.execution };
      }

      case 'EAT_FOOD': {
        const res = await bot.actions.execute({
          action: 'eat_food',
          goal: 'restore hunger and health'
        });
        return { action: 'eat_food', args: {}, result: res.execution };
      }

      case 'GATHER_FOOD': {
        // Check for nearby passive animals to hunt for meat
        const passiveMobs = ['cow', 'pig', 'sheep', 'chicken', 'rabbit'];
        let targetAnimal = null;
        let animalDist = Infinity;
        if (bot.entities) {
          for (const id in bot.entities) {
            const e = bot.entities[id];
            if (e && e.name && passiveMobs.includes(e.name.toLowerCase()) && e.position && bot.entity?.position) {
              const d = bot.entity.position.distanceTo(e.position);
              if (d < animalDist && d <= 32) {
                animalDist = d;
                targetAnimal = e;
              }
            }
          }
        }

        if (targetAnimal) {
          const res = await bot.actions.execute({
            action: 'attack_target',
            args: { target: targetAnimal.name },
            goal: `hunt ${targetAnimal.name} for food meat`
          });
          return { action: 'attack_target', args: { target: targetAnimal.name }, result: res.execution };
        }

        const res = await bot.actions.execute({
          action: 'collect_resource',
          args: { resource: 'sweet_berries' },
          goal: 'gather reachable food'
        });
        return { action: 'collect_resource', args: { resource: 'sweet_berries' }, result: res.execution };
      }

      default: {
        const fallbackAction = goalDef?.targetAction || 'inspect_inventory';
        const res = await bot.actions.execute({
          action: fallbackAction,
          args: {},
          goal: `execute ${goalId}`
        });
        return { action: fallbackAction, args: {}, result: res.execution };
      }
    }
  }
}

export const defaultAutonomousController = new AutonomousSurvivalController();
export default defaultAutonomousController;
