import fs from 'fs';
import path from 'path';
import config from '../config/index.js';
import { STAGES, STAGE_CONFIG } from './stages.js';

export class ProgressionStateMachine {
  constructor(options = {}) {
    this.currentStage = options.initialStage || STAGES.FARMER;
    this.storagePath = options.storagePath || path.join(config.storage.dataDir, 'progression.json');
    this.stats = {
      mobs_killed_total: 0,
      mobs_killed_by_type: {},
      damage_dealt_total: 0,
      damage_taken_total: 0,
      deaths_total: 0,
      food_harvested_total: 0,
      chests_placed: 0,
      items_stored_total: 0,
      blaze_rods_collected: 0,
      ender_pearls_collected: 0,
      eyes_of_ender_crafted: 0,
      stronghold_located: false,
      crystals_destroyed: 0,
      dragon_defeated: false
    };

    this.history = [];
    this.load();
  }

  /**
   * Evaluates if the agent qualifies to advance to the next stage.
   * @param {Object} observation 
   * @returns {{ canAdvance: boolean, currentStage: string, nextStage: string|null, prerequisites: Array<{ id: string, description: string, met: boolean }> }}
   */
  evaluateAdvancement(observation) {
    const config = STAGE_CONFIG[this.currentStage];
    if (!config || !config.nextStage) {
      return {
        canAdvance: false,
        currentStage: this.currentStage,
        nextStage: null,
        prerequisites: []
      };
    }

    const prereqs = config.prerequisitesForNext || [];
    const evaluation = prereqs.map(p => ({
      id: p.id,
      description: p.description,
      met: Boolean(p.check(this.stats, observation))
    }));

    const canAdvance = evaluation.length > 0 && evaluation.every(p => p.met);

    return {
      canAdvance,
      currentStage: this.currentStage,
      nextStage: config.nextStage,
      prerequisites: evaluation
    };
  }

  /**
   * Advances the agent to the next stage if prerequisites are met.
   * @param {Object} observation 
   * @param {Object} [bot] 
   * @returns {{ success: boolean, previousStage: string, currentStage: string, reason?: string }}
   */
  advanceStage(observation, bot = null) {
    const evalResult = this.evaluateAdvancement(observation);
    if (!evalResult.canAdvance) {
      const missing = evalResult.prerequisites.filter(p => !p.met).map(p => p.description).join('; ');
      return {
        success: false,
        previousStage: this.currentStage,
        currentStage: this.currentStage,
        reason: `Prerequisites not met: ${missing}`
      };
    }

    const previousStage = this.currentStage;
    this.currentStage = evalResult.nextStage;

    const transitionRecord = {
      timestamp: new Date().toISOString(),
      from_stage: previousStage,
      to_stage: this.currentStage,
      stats_snapshot: { ...this.stats }
    };
    this.history.push(transitionRecord);
    this.save();

    console.log(`[Progression] *** STAGE UNLOCKED: Promoted from '${previousStage}' to '${this.currentStage.toUpperCase()}'! ***`);
    if (bot && typeof bot.chat === 'function') {
      bot.chat(`[MIKA Progression] Promoted to Stage: ${this.currentStage.toUpperCase()}! New tactical capabilities unlocked.`);
    }

    return {
      success: true,
      previousStage,
      currentStage: this.currentStage
    };
  }

  /**
   * Records a hostile mob kill into the progression stats.
   * @param {string} mobType 
   * @param {number} [damage=0] 
   */
  recordKill(mobType = 'unknown', damage = 0) {
    this.stats.mobs_killed_total += 1;
    this.stats.mobs_killed_by_type[mobType] = (this.stats.mobs_killed_by_type[mobType] || 0) + 1;
    this.stats.damage_dealt_total += damage;
    this.save();
  }

  /**
   * Records damage taken.
   * @param {number} damage 
   */
  recordDamageTaken(damage) {
    if (damage > 0) {
      this.stats.damage_taken_total += damage;
      this.save();
    }
  }

  /**
   * Records agent death.
   */
  recordDeath() {
    this.stats.deaths_total += 1;
    this.save();
  }

  /**
   * Generates a complete status summary for chat, HUD, and planning context.
   * @param {Object} [observation] 
   * @returns {Object} Structured status
   */
  getStatusSummary(observation = null) {
    const cfg = STAGE_CONFIG[this.currentStage] || {};
    const advancement = observation ? this.evaluateAdvancement(observation) : null;

    return {
      stage: this.currentStage,
      title: cfg.title,
      description: cfg.description,
      stats: { ...this.stats },
      advancement_ready: advancement ? advancement.canAdvance : false,
      next_stage: cfg.nextStage || 'MAX_STAGE_REACHED',
      prerequisites_checklist: advancement ? advancement.prerequisites : []
    };
  }

  save() {
    try {
      const dataDir = path.dirname(this.storagePath);
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(this.storagePath, JSON.stringify({
        currentStage: this.currentStage,
        stats: this.stats,
        history: this.history
      }, null, 2), 'utf-8');
    } catch (err) {
      console.warn(`[Progression] Could not save progression state: ${err.message}`);
    }
  }

  load() {
    try {
      if (fs.existsSync(this.storagePath)) {
        const raw = fs.readFileSync(this.storagePath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (parsed.currentStage && STAGE_CONFIG[parsed.currentStage]) {
          this.currentStage = parsed.currentStage;
        }
        if (parsed.stats) {
          this.stats = { ...this.stats, ...parsed.stats };
        }
        if (Array.isArray(parsed.history)) {
          this.history = parsed.history;
        }
      }
    } catch (err) {
      console.warn(`[Progression] Could not load progression state: ${err.message}`);
    }
  }
}

export const defaultProgression = new ProgressionStateMachine();
export default defaultProgression;
