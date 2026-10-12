/**
 * MIKA V1.3 — Problem Detector
 * 
 * Continuously compares world state, action results, vitals, and task progress
 * against expected outcomes to detect failures and anomalies.
 * 
 * Calibrated using empirical Minecraft runtime experiences (4,400+ episodes).
 */

export const PROBLEM_TYPES = Object.freeze({
  ACTION_FAILED: 'ACTION_FAILED',
  CRITICAL_VITALS: 'CRITICAL_VITALS',
  RESOURCE_NOT_FOUND: 'RESOURCE_NOT_FOUND',
  PREREQUISITE_MISSING: 'PREREQUISITE_MISSING',
  CRAFTING_BLOCKED: 'CRAFTING_BLOCKED',
  BLOCK_PLACEMENT_FAILED: 'BLOCK_PLACEMENT_FAILED',
  NAVIGATION_BLOCKED: 'NAVIGATION_BLOCKED',
  TARGET_UNREACHABLE: 'TARGET_UNREACHABLE',
  THREAT_INTERRUPTED: 'THREAT_INTERRUPTED',
  TASK_STAGNATION: 'TASK_STAGNATION',
  STORAGE_ERROR: 'STORAGE_ERROR',
  UNVERIFIED_COMPLETION: 'UNVERIFIED_COMPLETION',
  CONFLICTING_ASSIGNMENT: 'CONFLICTING_ASSIGNMENT',
  TOOL_OR_CONNECTION_DOWN: 'TOOL_OR_CONNECTION_DOWN'
});

export const SEVERITY = Object.freeze({
  CRITICAL: 'CRITICAL',
  HIGH: 'HIGH',
  MEDIUM: 'MEDIUM',
  LOW: 'LOW'
});

// Calibrated empirical parameters from Minecraft world telemetry
export const EMPIRICAL_THRESHOLDS = Object.freeze({
  HEALTH_CRITICAL: 8.0,          // Actual Minecraft abort boundary: ~5.3 - 7.8
  HEALTH_LOW: 12.0,
  HUNGER_CRITICAL: 6.0,          // Sprint disabled & starving boundary
  HUNGER_HUNGRY: 14.0,           // Health regeneration boundary
  MAX_RETRY_STAGNATION: 2,       // Stop repeated failing attempts (prevents 900+ sweet_berries loops)
  MAX_RESOURCE_SEARCH_DIST: 32,
  THREAT_PANIC_DISTANCE: 6.0,
  ACTION_TIMEOUT_MS: 25000
});

export class ProblemDetector {
  constructor(thresholds = {}) {
    this.thresholds = { ...EMPIRICAL_THRESHOLDS, ...thresholds };
    this.stagnationTracker = new Map(); // taskKey -> consecutive failure count
  }

  /**
   * Detects problems from action execution, post-observation, and task progress.
   * 
   * @param {Object} params
   * @param {import('mineflayer').Bot} [params.bot]
   * @param {string} [params.action]
   * @param {Object} [params.args]
   * @param {Object} [params.execution]
   * @param {Object} [params.outcome]
   * @param {Object} [params.preObservation]
   * @param {Object} [params.postObservation]
   * @param {string} [params.currentGoal]
   * @param {number} [params.retryCount]
   * @returns {{ hasProblem: boolean, problemType: string|null, severity: string|null, evidence: string, details: Object }}
   */
  detectProblem({
    bot = null,
    action = null,
    args = {},
    execution = {},
    outcome = {},
    preObservation = {},
    postObservation = {},
    currentGoal = 'unknown',
    retryCount = 0
  } = {}) {
    const errorMsg = execution.error || '';
    const errorCode = execution.error_code || '';
    const isExecutionFailed = execution.status === 'failed' || execution.status === 'timeout';
    const health = bot?.health ?? postObservation.agent?.health ?? 20;
    const food = bot?.food ?? postObservation.agent?.food ?? 20;
    const taskKey = `${currentGoal}:${action}`;

    // 1. Critical Vitals Check (Health < 8 or Hunger < 6)
    if (health <= this.thresholds.HEALTH_CRITICAL) {
      return {
        hasProblem: true,
        problemType: PROBLEM_TYPES.CRITICAL_VITALS,
        severity: SEVERITY.CRITICAL,
        evidence: `Health is critical (${health.toFixed(1)}/20 <= ${this.thresholds.HEALTH_CRITICAL}). Risk of death.`,
        details: { health, food, errorMsg, action, currentGoal }
      };
    }
    if (food <= this.thresholds.HUNGER_CRITICAL) {
      return {
        hasProblem: true,
        problemType: PROBLEM_TYPES.CRITICAL_VITALS,
        severity: SEVERITY.HIGH,
        evidence: `Hunger is critical (${food}/20 <= ${this.thresholds.HUNGER_CRITICAL}). Regeneration halted and sprint disabled.`,
        details: { health, food, errorMsg, action, currentGoal }
      };
    }

    // 2. Active Threat Interruption (Damage taken or hostile mob within 6m)
    const damageTaken = outcome.damage_taken || 0;
    const threats = postObservation.nearby_threats || preObservation.nearby_threats || [];
    const closeThreat = threats.find(t => (t.distance || 10) <= this.thresholds.THREAT_PANIC_DISTANCE);
    if (damageTaken > 0 || closeThreat || errorMsg.includes('Interrupted by hostile mob')) {
      return {
        hasProblem: true,
        problemType: PROBLEM_TYPES.THREAT_INTERRUPTED,
        severity: SEVERITY.CRITICAL,
        evidence: closeThreat
          ? `Hostile mob '${closeThreat.name}' at close range (${closeThreat.distance.toFixed(1)}m <= ${this.thresholds.THREAT_PANIC_DISTANCE}m)`
          : `Bot sustained ${damageTaken} damage during '${action}'`,
        details: { threat: closeThreat, damageTaken, errorMsg, currentGoal }
      };
    }

    // 3. Stagnation & Infinite Retry Thrashing Check
    const currentFailures = (this.stagnationTracker.get(taskKey) || 0) + (isExecutionFailed ? 1 : 0);
    if (isExecutionFailed) {
      this.stagnationTracker.set(taskKey, currentFailures);
    } else {
      this.stagnationTracker.delete(taskKey);
    }
    if (currentFailures >= this.thresholds.MAX_RETRY_STAGNATION) {
      return {
        hasProblem: true,
        problemType: PROBLEM_TYPES.TASK_STAGNATION,
        severity: SEVERITY.HIGH,
        evidence: `Task stagnation detected: '${taskKey}' has failed ${currentFailures} times consecutively with no progress`,
        details: { consecutiveFailures: currentFailures, taskKey, errorMsg }
      };
    }

    // 4. Resource Not Found (Empirically sweet_berries, wood, stone)
    if (errorCode === 'RESOURCE_NOT_FOUND' || errorMsg.includes('found within') || errorMsg.includes('could not be located')) {
      return {
        hasProblem: true,
        problemType: PROBLEM_TYPES.RESOURCE_NOT_FOUND,
        severity: SEVERITY.HIGH,
        evidence: errorMsg || `Resource '${args.resource || 'unknown'}' not found within search radius`,
        details: { resource: args.resource, errorMsg, errorCode }
      };
    }

    // 5. Crafting Blocked (3x3 Crafting Table required or missing ingredients)
    if (errorCode === 'CRAFTING_TABLE_REQUIRED' || errorMsg.includes('requires a crafting table')) {
      return {
        hasProblem: true,
        problemType: PROBLEM_TYPES.CRAFTING_BLOCKED,
        severity: SEVERITY.MEDIUM,
        evidence: `Crafting '${args.item || 'item'}' requires an accessible 3x3 crafting table`,
        details: { item: args.item, requiresTable: true, errorMsg }
      };
    }
    if (errorCode === 'MISSING_INGREDIENTS' || errorMsg.includes('missing ingredient')) {
      return {
        hasProblem: true,
        problemType: PROBLEM_TYPES.PREREQUISITE_MISSING,
        severity: SEVERITY.HIGH,
        evidence: errorMsg || `Missing ingredients for crafting '${args.item || 'item'}'`,
        details: { item: args.item, errorMsg }
      };
    }

    // 6. Block Placement Refused or Obstructed
    if (errorCode === 'PLACE_BLOCK_ERROR' || errorMsg.includes('Server refused to place') || errorMsg.includes('cannot be placed here')) {
      return {
        hasProblem: true,
        problemType: PROBLEM_TYPES.BLOCK_PLACEMENT_FAILED,
        severity: SEVERITY.HIGH,
        evidence: errorMsg || `Server refused block placement at target position`,
        details: { block: args.block || args.item, targetPos: args, errorMsg }
      };
    }

    // 7. Navigation & Pathfinding Failures
    if (errorCode === 'NAVIGATION_TIMEOUT' || errorCode === 'UNREACHABLE_TARGET' || errorMsg.includes('Navigation timed out') || errorMsg.includes('Pathfinding failed')) {
      return {
        hasProblem: true,
        problemType: PROBLEM_TYPES.NAVIGATION_BLOCKED,
        severity: SEVERITY.MEDIUM,
        evidence: errorMsg || `Pathfinder could not reach destination within timeout`,
        details: { target: args, errorMsg }
      };
    }

    // 8. General Action Execution Failure
    if (isExecutionFailed) {
      return {
        hasProblem: true,
        problemType: PROBLEM_TYPES.ACTION_FAILED,
        severity: SEVERITY.MEDIUM,
        evidence: errorMsg || `Action '${action}' finished with status: ${execution.status}`,
        details: { action, args, execution, outcome }
      };
    }

    // 9. Unverified Completion (Action reports success, but world state deltas are zero)
    if (execution.status === 'success' && outcome.predicted_outcome_met === false && outcome.task_progress === 0) {
      return {
        hasProblem: true,
        problemType: PROBLEM_TYPES.UNVERIFIED_COMPLETION,
        severity: SEVERITY.LOW,
        evidence: `Action '${action}' completed without errors, but produced zero measurable world progress`,
        details: { action, args, outcome }
      };
    }

    return {
      hasProblem: false,
      problemType: null,
      severity: null,
      evidence: 'Nominal operation; no problems detected',
      details: {}
    };
  }

  resetStagnation(taskKey = null) {
    if (taskKey) {
      this.stagnationTracker.delete(taskKey);
    } else {
      this.stagnationTracker.clear();
    }
  }
}

export const defaultProblemDetector = new ProblemDetector();
export default defaultProblemDetector;
