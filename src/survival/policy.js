import {
  SURVIVAL_CONFIG,
  GoalExecutionTracker,
  isNightOrDusk,
  evaluateThreatLevel,
  selectContextualGoal,
  getSurvivalStatusReport
} from './priority.js';

/**
 * Survival Policy Engine
 * Prioritizes immediate survival threats, environmental hazards, hunger,
 * and emergency retreat using foundational rules rather than hardcoded scripts.
 */
export class SurvivalPolicy {
  constructor(config = SURVIVAL_CONFIG) {
    this.config = config;
    this.tracker = new GoalExecutionTracker(config.MAX_RETRIES_PER_GOAL);
  }

  /**
   * Evaluates the observation and decides the highest priority survival objective.
   *
   * Urgency Hierarchy (Tiers 1 to 6):
   * 1. Immediate hostile threat and low health (retreat or combat defense)
   * 2. Nightfall approaching or active darkness (emergency shelter)
   * 3. Hunger below regenerative threshold (sustenance)
   * 4. Basic emergency building blocks (dirt/sand gathering)
   * 5. Foundational survival progression (wood, tools, crafting table)
   * 6. Upgrades, storage, and exploration
   *
   * @param {Object} observation
   * @param {Object} [memoryStore]
   * @returns {{
   *   goalId: string,
   *   tier: number,
   *   reason: string,
   *   plan: string[],
   *   isFallback: boolean,
   *   emergencyRetreat?: { x: number, z: number, range: number }
   * }}
   */
  evaluatePriorities(observation, memoryStore = null) {
    const priority = selectContextualGoal(observation, memoryStore, this.tracker);

    // If immediate threat requires retreat coordinates, calculate vector away from threat
    let emergencyRetreat = null;
    const threats = observation?.nearby_threats || [];
    const closeThreat = threats.find(t => t.distance <= this.config.THREAT_PANIC_DISTANCE);
    const health = observation?.agent?.health ?? 20;

    if (closeThreat && health <= this.config.HEALTH_LOW && observation?.agent?.position) {
      const pos = observation.agent.position;
      const tPos = closeThreat.position;
      // Step vector directly away from threat
      const dx = pos.x - tPos.x;
      const dz = pos.z - tPos.z;
      const dist = Math.hypot(dx, dz) || 1;
      emergencyRetreat = {
        x: Math.round(pos.x + (dx / dist) * 10),
        z: Math.round(pos.z + (dz / dist) * 10),
        range: 2.0
      };
    }

    return {
      ...priority,
      emergencyRetreat
    };
  }

  /**
   * Records execution outcome with retry tracker to prevent infinite loops.
   * @param {string} goalId
   * @param {boolean} success
   * @param {string} reason
   */
  recordOutcome(goalId, success, reason = '') {
    this.tracker.recordAttempt(goalId, success, reason);
  }

  /**
   * Generates a human-readable survival telemetry status report.
   * @param {Object} observation
   * @returns {string}
   */
  getStatusReport(observation) {
    return getSurvivalStatusReport(observation);
  }

  /**
   * Resets retry tracker states.
   */
  reset() {
    this.tracker.reset();
  }
}

export const defaultSurvivalPolicy = new SurvivalPolicy();
