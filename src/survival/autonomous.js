import { selectContextualGoal, GoalExecutionTracker } from './priority.js';
import { resolveGoalPlan, GOAL_DEFINITIONS } from '../learning/goals.js';
import { evaluateGoalOutcome } from '../learning/evaluate.js';
import defaultShelterManager from './shelter.js';
import { defaultProgression } from '../progression/state-machine.js';
import defaultAdaptiveThinking from '../learning/adaptive-thinking.js';
import { TaskManager, TASK_STATE, TASK_CATEGORY } from '../tasks/task-manager.js';
import { defaultThreatManager, ThreatManager } from './threat-manager.js';
import { defaultBaseShelter, BaseShelterBuilder } from './base-shelter.js';
import { defaultCraftingKnowledge, CraftingKnowledgeSystem } from '../crafting/knowledge.js';
import { defaultFoodManager, FoodManager } from './food-manager.js';
import { defaultBedManager, BedManager } from './bed-manager.js';
import { defaultStorageOrganizer, StorageOrganizer } from '../storage/organization.js';

/**
 * Autonomous Survival Loop Controller.
 * Drives MIKA through continuous first-principles survival cycles:
 * Observe -> Prioritize -> Plan -> Act -> Verify -> Learn.
 */
export class AutonomousSurvivalController {
  constructor(options = {}) {
    this.tracker = new GoalExecutionTracker(3);
    this.taskManager = options.taskManager || new TaskManager();
    this.threatManager = options.threatManager || defaultThreatManager;
    this.baseShelter = options.baseShelter || defaultBaseShelter;
    this.craftingKnowledge = options.craftingKnowledge || defaultCraftingKnowledge;
    this.foodManager = options.foodManager || defaultFoodManager;
    this.bedManager = options.bedManager || defaultBedManager;
    this.storageOrganizer = options.storageOrganizer || defaultStorageOrganizer;
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

    // Update persistent threat memory
    if (this.threatManager && bot.entity?.position) {
      this.threatManager.updateThreatTracking(preObs, bot.entity.position);
    }

    // 2. Select contextual priority goal
    const priority = selectContextualGoal(preObs, bot.memoryStore, this.tracker, this.taskManager);
    let topGoalId = priority.goalId;
    let priorityTier = priority.tier;
    let goalReason = priority.reason;

    // Check emergency preemption: interrupt active task if emergency threat occurs
    const activeTask = this.taskManager.getActiveTask();
    if (activeTask && activeTask.state === TASK_STATE.IN_PROGRESS && priorityTier <= 2 && activeTask.id !== topGoalId) {
      this.taskManager.interruptCurrentTask(`Threat interruption: Tier ${priorityTier} (${goalReason})`, activeTask.progress.checkpoint);
      if (typeof bot.chat === 'function') {
        bot.chat(`[Threat Interrupt] Paused ${activeTask.id} at checkpoint (Tier ${priorityTier} threat)`);
      }
    }

    // Check resumption: if priority indicates resuming interrupted task
    if (priority.isResumed && this.taskManager.hasInterruptedTasks()) {
      const resumed = this.taskManager.resumeInterruptedTask();
      if (resumed) {
        topGoalId = resumed.id;
        priorityTier = 3;
        goalReason = `Resumed from checkpoint: ${JSON.stringify(resumed.progress.checkpoint || {})}`;
      }
    }

    // Assigned mission goal takes priority unless immediate mortal danger (Tier 1) requires retreat
    if (bot.assignedGoal && priorityTier > 1) {
      const assignedDef = GOAL_DEFINITIONS[bot.assignedGoal];
      if (assignedDef) {
        const isDone = assignedDef.isCompleted(preObs);
        if (isDone.completed) {
          console.log(`[Goal Accomplished] Assigned goal '${bot.assignedGoal}' fulfilled: ${isDone.reason}`);
          if (typeof bot.chat === 'function') {
            bot.chat(`[Goal Accomplished!] ${bot.assignedGoal} - ${isDone.reason}`);
          }
          bot.assignedGoal = null;
        } else {
          topGoalId = bot.assignedGoal;
          priorityTier = 2;
          goalReason = `Assigned mission goal: ${bot.assignedGoal}`;
        }
      }
    }

    bot.lastGoalId = topGoalId;
    console.log(`[Auto-Survival] Priority Tier ${priorityTier}: ${topGoalId} ("${goalReason}")`);

    // 3. Resolve dependencies to pick the immediate executable step
    const plan = resolveGoalPlan(topGoalId, preObs);
    const currentGoalId = plan[0] || topGoalId;

    // Register & start task in TaskManager if not active
    let currentTask = this.taskManager.getTask(currentGoalId);
    if (!currentTask) {
      currentTask = this.taskManager.register({
        id: currentGoalId,
        objective: goalReason,
        priorityTier
      });
    }
    if (currentTask.state === TASK_STATE.READY || currentTask.state === TASK_STATE.PLANNED) {
      try {
        this.taskManager.startTask(currentGoalId);
      } catch (_) {}
    }

    if (typeof bot.chat === 'function') {
      bot.chat(`[Priority T${priorityTier}] Goal: ${currentGoalId}${bot.assignedGoal ? ` (Target: ${bot.assignedGoal})` : ''}`);
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

    // 6b. General Problem Identification, Diagnosis, and Resolution Engine
    if (!evaluation.goalAchieved || execOutcome.result?.status !== 'success' || (postObs.agent?.health && postObs.agent.health <= 8)) {
      try {
        const { defaultProblemSolver } = await import('../diagnostics/index.js');
        const diagResult = await defaultProblemSolver.handleProblem({
          bot,
          action: execOutcome.action,
          args: execOutcome.args,
          execution: execOutcome.result,
          outcome: evaluation,
          preObservation: preObs,
          postObservation: postObs,
          currentGoal: currentGoalId
        });
        if (diagResult.resolved && diagResult.recoveryResult?.successfulPlan) {
          console.log(`[Auto-Survival] Autonomous Problem Resolution: Resolved via [${diagResult.recoveryResult.successfulPlan.action}]`);
        }
      } catch (diagErr) {
        console.warn(`[Auto-Survival] ProblemSolver error: ${diagErr.message}`);
      }
    }

    // 7. Track retries to prevent infinite loops
    this.tracker.recordAttempt(currentGoalId, evaluation.goalAchieved, evaluation.completionReason);

    // 7b. Empirical World Verification in TaskManager
    try {
      this.taskManager.verifyAndComplete(currentGoalId, () => ({
        verified: evaluation.goalAchieved,
        reason: evaluation.completionReason
      }), { worldState: postObs });
    } catch (_) {}

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

      case 'BUILD_TWO_PLAYER_SHELTER': {
        const { defaultTwoPlayerShelterSkill } = await import('../skills/two-player-shelter.js');
        const execResult = await defaultTwoPlayerShelterSkill.adaptSkillToWorld(bot);
        if (execResult.isComplete) {
          defaultTwoPlayerShelterSkill.saveAsLearnedSkill(execResult);
        }
        return { action: 'build_shelter', args: { type: 'two_player' }, result: execResult };
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

      case 'BUILD_BASE_SHELTER': {
        const siteAssessment = this.baseShelter.assessBaseLocation(bot);
        const site = siteAssessment.bestSite || (bot.entity?.position ? bot.entity.position.floored() : { x: 0, y: 64, z: 0 });
        const blueprint = this.baseShelter.generateShelterBlueprint(site);
        const task = this.taskManager.getTask('BUILD_BASE_SHELTER');
        const checkpoint = task?.progress?.checkpoint || null;
        const res = await this.baseShelter.buildShelterPhased(bot, blueprint, checkpoint, (prog) => {
          if (task) task.updateCheckpoint(prog);
        });
        return { action: 'build_base_shelter', args: { site }, result: res };
      }

      case 'CRAFT_AND_PLACE_BED': {
        const evalBed = this.bedManager.evaluateBedProgression(bot, this.taskManager, 'CRAFT_AND_PLACE_BED');
        if (evalBed.blocked) {
          return { action: 'place_bed', args: {}, result: { status: 'blocked', reason: evalBed.reason } };
        }
        const inv = typeof bot.inventory?.items === 'function' ? bot.inventory.items() : (bot.inventory || []);
        const hasBed = inv.some(i => i.name.includes('bed'));
        if (!hasBed) {
          await this.craftingKnowledge.craftItemWithVerification(bot, 'white_bed', 1);
        }
        const shelter = bot.memoryStore?.getLocation ? bot.memoryStore.getLocation('shelter') : null;
        const targetSlot = shelter?.position ? { x: shelter.position.x + 2, y: shelter.position.y, z: shelter.position.z + 2 } : (bot.entity?.position || { x: 0, y: 64, z: 0 });
        const placeRes = await this.bedManager.placeBedInShelter(bot, targetSlot);
        return { action: 'place_bed', args: {}, result: placeRes };
      }

      case 'COOK_FOOD': {
        const inv = typeof bot.inventory?.items === 'function' ? bot.inventory.items() : (bot.inventory || []);
        const cookable = inv.find(i => ['raw_beef', 'raw_porkchop', 'raw_mutton', 'raw_chicken', 'potato'].includes(i.name));
        const rawName = cookable ? cookable.name : 'raw_beef';
        const cookRes = await this.foodManager.cookFoodInFurnace(bot, rawName, 1);
        return { action: 'cook_food', args: { item: rawName }, result: cookRes };
      }

      case 'ORGANIZE_STORAGE': {
        const inv = typeof bot.inventory?.items === 'function' ? bot.inventory.items() : (bot.inventory || []);
        const surplus = this.storageOrganizer.calculateDepositableSurplus(inv);
        const mockChest = { occupiedSlots: 0, deposit: async () => {} };
        const depositRes = await this.storageOrganizer.depositSurplusIntoChest(bot, mockChest, surplus);
        return { action: 'organize_storage', args: { count: surplus.length }, result: depositRes };
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
