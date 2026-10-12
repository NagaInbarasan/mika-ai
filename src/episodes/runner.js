import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import config from '../config/index.js';
import { defaultBaselinePlanner } from './baseline.js';

export class EpisodeManager {
  constructor(options = {}) {
    this.reportsDir = options.reportsDir || path.join(config.storage.dataDir, 'reports');
    this.episodesLogPath = path.join(this.reportsDir, 'episodes.jsonl');
    this.currentEpisode = null;
    this.baselinePlanner = options.baselinePlanner || defaultBaselinePlanner;
    this.stepDelayMs = options.stepDelayMs !== undefined ? options.stepDelayMs : 1000;

    fs.mkdirSync(this.reportsDir, { recursive: true });
  }

  /**
   * Runs a complete, bounded episode for a specified progressive task.
   * @param {Object} params
   * @param {import('mineflayer').Bot} params.bot
   * @param {string} params.taskType - 'gather_resource' | 'navigate_and_return' | 'hazard_avoidance'
   * @param {Object} [params.taskTarget={}] - Target parameters (e.g. { resource: 'sand', count: 3 })
   * @param {string} [params.strategy='qwen'] - 'qwen' or 'baseline'
   * @param {number} [params.maxSteps=12] - Max action budget
   * @param {number} [params.timeoutMs=60000] - Total episode duration budget
   * @returns {Promise<Object>} Final episode report with summary metrics
   */
  async runEpisode({ bot, taskType, taskTarget = {}, strategy = 'qwen', maxSteps = 12, timeoutMs = 60000, stepDelayMs }) {
    if (!bot || !bot.isReady) {
      throw new Error('Bot is not ready to begin episode');
    }

    const episodeId = `ep-${Date.now()}-${uuidv4().slice(0, 6)}`;
    const startTime = Date.now();
    const initialObs = bot.collectObservation(bot);

    // Initial Inventory target tracking
    const targetResource = taskTarget.resource || 'sand';
    const targetCount = taskTarget.count || 2;
    const initialResCount = this._getItemCount(initialObs, targetResource);
    const startPos = { ...initialObs.agent.position };

    const episodeState = {
      episode_id: episodeId,
      task_type: taskType,
      task_target: taskTarget,
      strategy,
      start_time: new Date().toISOString(),
      initial_conditions: {
        position: startPos,
        health: initialObs.agent.health,
        food: initialObs.agent.food,
        target_initial_count: initialResCount
      },
      steps: [],
      metrics: {
        total_steps: 0,
        failed_actions: 0,
        recovery_attempts: 0,
        recoveries_succeeded: 0,
        damage_taken: 0,
        resource_delta: {},
        inference_calls: 0,
        total_inference_latency_ms: 0
      },
      completion_status: 'in_progress',
      termination_reason: null
    };

    this.currentEpisode = episodeState;
    console.log(`[Episode] Starting ${episodeId} | Task: ${taskType} | Strategy: ${strategy} | Budget: ${maxSteps} steps`);
    if (bot.chat) {
      bot.chat(`[Episode ${episodeId.slice(-6)}] Started task: ${taskType} (${strategy})`);
    }

    // Main Bounded Step Loop
    while (episodeState.metrics.total_steps < maxSteps) {
      const elapsed = Date.now() - startTime;
      if (elapsed >= timeoutMs) {
        episodeState.termination_reason = 'timeout';
        break;
      }

      if (!bot.isReady || !bot.entity || bot.health <= 0) {
        episodeState.termination_reason = 'fatal_damage';
        break;
      }

      episodeState.metrics.total_steps += 1;
      const stepNumber = episodeState.metrics.total_steps;
      const currentObs = bot.collectObservation(bot);

      // Check task success condition before stepping
      if (this._checkTaskCompleted(taskType, currentObs, initialResCount, targetCount, targetResource, startPos)) {
        episodeState.completion_status = 'success';
        episodeState.termination_reason = 'goal_completed';
        break;
      }

      // Step Action Generation: Qwen vs Scripted Baseline
      let decision;
      if (strategy === 'baseline') {
        decision = this.baselinePlanner.proposeAction({
          observation: currentObs,
          taskType,
          taskTarget
        });
      } else {
        episodeState.metrics.inference_calls += 1;
        const planRes = await bot.planner.planNextStep({
          observation: currentObs,
          goal: `Task ${taskType}: collect ${targetCount} ${targetResource} or complete objective`
        });
        decision = planRes.decision;
        episodeState.metrics.total_inference_latency_ms += (planRes.latencyMs || 0);
      }

      // Execute Action
      const execResult = await bot.actions.execute({
        action: decision.action,
        args: decision.arguments,
        goal: decision.goal || taskType,
        expectedOutcome: decision.expected_outcome
      });

      // Track step details
      const isFailed = execResult.execution.status !== 'success';
      if (isFailed) {
        episodeState.metrics.failed_actions += 1;
        // Bounded recovery trigger
        if (bot.recovery) {
          episodeState.metrics.recovery_attempts += 1;
          const rec = await bot.recovery.attemptRecovery({
            bot,
            failedStep: {
              action: decision.action,
              args: decision.arguments,
              execution: execResult.execution,
              outcome: execResult.outcome,
              observationBefore: currentObs,
              eventId: bot.lastEventId
            }
          });
          if (rec.recovered) {
            episodeState.metrics.recoveries_succeeded += 1;
          }
        }
      }

      if (execResult.outcome && execResult.outcome.damage_taken > 0) {
        episodeState.metrics.damage_taken += execResult.outcome.damage_taken;
      }

      episodeState.steps.push({
        step: stepNumber,
        action: decision.action,
        status: execResult.execution.status,
        duration_ms: execResult.execution.duration_ms
      });

      // Post-step success check
      const postObs = bot.collectObservation(bot);
      if (this._checkTaskCompleted(taskType, postObs, initialResCount, targetCount, targetResource, startPos)) {
        episodeState.completion_status = 'success';
        episodeState.termination_reason = 'goal_completed';
        break;
      }

      const delay = stepDelayMs !== undefined ? stepDelayMs : this.stepDelayMs;
      if (delay > 0) {
        await new Promise(r => setTimeout(r, delay));
      }
    }

    if (!episodeState.termination_reason) {
      episodeState.termination_reason = 'step_budget_exhausted';
      episodeState.completion_status = 'failure';
    }

    // Finalize Metrics
    const finalObs = bot.collectObservation(bot);
    const finalResCount = this._getItemCount(finalObs, targetResource);
    const totalDuration = Date.now() - startTime;

    episodeState.end_time = new Date().toISOString();
    episodeState.duration_ms = totalDuration;
    episodeState.metrics.resource_delta[targetResource] = finalResCount - initialResCount;
    episodeState.metrics.avg_inference_latency_ms = episodeState.metrics.inference_calls > 0
      ? Math.round(episodeState.metrics.total_inference_latency_ms / episodeState.metrics.inference_calls)
      : 0;

    // Log completed episode summary to episodes.jsonl
    this._logEpisodeSummary(episodeState);

    console.log(`[Episode ${episodeId.slice(-6)}] Completed: status=${episodeState.completion_status}, reason=${episodeState.termination_reason}, steps=${episodeState.metrics.total_steps}, duration=${totalDuration}ms`);
    if (bot.chat) {
      bot.chat(`[Episode Done] Status: ${episodeState.completion_status} (${episodeState.termination_reason}). Steps: ${episodeState.metrics.total_steps}`);
    }

    this.currentEpisode = null;
    return episodeState;
  }

  _checkTaskCompleted(taskType, currentObs, initialResCount, targetCount, targetResource, startPos) {
    if (taskType === 'gather_resource') {
      const currentRes = this._getItemCount(currentObs, targetResource);
      return currentRes >= initialResCount + targetCount;
    }
    if (taskType === 'navigate_and_return') {
      // Completed if moved away and returned within 2m of start
      const currentPos = currentObs.agent.position;
      const distToStart = Math.sqrt(
        Math.pow(currentPos.x - startPos.x, 2) + Math.pow(currentPos.z - startPos.z, 2)
      );
      return distToStart <= 2.0;
    }
    if (taskType === 'hazard_avoidance') {
      return (currentObs.nearby_threats || []).length === 0;
    }
    return false;
  }

  _getItemCount(obs, itemName) {
    if (!obs || !obs.inventory) return 0;
    const item = obs.inventory.find(i => i.name === itemName);
    return item ? item.count : 0;
  }

  _logEpisodeSummary(episode) {
    try {
      const line = JSON.stringify(episode) + '\n';
      fs.appendFileSync(this.episodesLogPath, line, 'utf-8');
    } catch (err) {
      console.error(`[Episode] Error logging episode summary:`, err.message);
    }
  }
}

export const defaultEpisodeManager = new EpisodeManager();
export default defaultEpisodeManager;
