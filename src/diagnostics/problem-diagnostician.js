import { PROBLEM_TYPES, SEVERITY } from './problem-detector.js';

/**
 * MIKA V1.3 — Problem Diagnostician
 * 
 * Investigates detected problems, determines root cause from environmental evidence,
 * and classifies them into standard problem categories.
 */

export const ROOT_CAUSE_CATEGORIES = Object.freeze({
  CRITICAL_HEALTH_OR_HUNGER: 'CRITICAL_HEALTH_OR_HUNGER',
  RESOURCE_DEPLETED_OR_ABSENT: 'RESOURCE_DEPLETED_OR_ABSENT',
  MISSING_WORKSTATION_OR_TOOL: 'MISSING_WORKSTATION_OR_TOOL',
  RECIPE_INGREDIENT_SHORTAGE: 'RECIPE_INGREDIENT_SHORTAGE',
  PHYSICAL_BLOCK_OBSTRUCTION: 'PHYSICAL_BLOCK_OBSTRUCTION',
  ENTITY_COLLISION_OBSTRUCTION: 'ENTITY_COLLISION_OBSTRUCTION',
  TERRAIN_UNREACHABLE_OR_HAZARD: 'TERRAIN_UNREACHABLE_OR_HAZARD',
  HOSTILE_THREAT_PRESSURE: 'HOSTILE_THREAT_PRESSURE',
  REPEATED_ACTION_THRASHING: 'REPEATED_ACTION_THRASHING',
  STORAGE_CAPACITY_EXCEEDED: 'STORAGE_CAPACITY_EXCEEDED',
  STATE_PREDICTION_MISMATCH: 'STATE_PREDICTION_MISMATCH',
  UNKNOWN_OR_UNSPECIFIED: 'UNKNOWN_OR_UNSPECIFIED'
});

export class ProblemDiagnostician {
  constructor(options = {}) {
    this.history = [];
  }

  /**
   * Diagnoses a detected problem using empirical evidence.
   * 
   * @param {Object} params
   * @param {Object} params.problem - Detected problem from ProblemDetector
   * @param {import('mineflayer').Bot} [params.bot]
   * @param {Object} [params.worldState]
   * @param {string} [params.currentTask]
   * @param {Array} [params.recentActions]
   * @returns {Object} Structured diagnostic record
   */
  diagnose({
    problem,
    bot = null,
    worldState = {},
    currentTask = 'unknown',
    recentActions = []
  }) {
    if (!problem || !problem.hasProblem) {
      return {
        hasDiagnosis: false,
        category: null,
        rootCause: 'No problem detected',
        confidence: 1.0,
        evidence: 'System operating within nominal parameters'
      };
    }

    const inventory = bot?.inventory?.items ? bot.inventory.items() : (worldState.inventory?.items || []);
    const health = bot?.health ?? worldState.agent?.health ?? 20;
    const food = bot?.food ?? worldState.agent?.food ?? 20;
    const pos = bot?.entity?.position ?? worldState.agent?.position ?? { x: 0, y: 0, z: 0 };

    let category = ROOT_CAUSE_CATEGORIES.UNKNOWN_OR_UNSPECIFIED;
    let rootCause = problem.evidence;
    let confidence = 0.85;
    let recommendedActionType = 'investigate';
    const contributingFactors = [];

    switch (problem.problemType) {
      case PROBLEM_TYPES.CRITICAL_VITALS: {
        category = ROOT_CAUSE_CATEGORIES.CRITICAL_HEALTH_OR_HUNGER;
        const edibleItems = inventory.filter(i => ['bread', 'cooked_beef', 'apple', 'baked_potato', 'carrot', 'sweet_berries'].some(k => i.name.includes(k)));
        if (health <= 8.0) {
          rootCause = `Health depleted (${health.toFixed(1)}/20) - actions halted to prevent death`;
          confidence = 0.99;
          contributingFactors.push(edibleItems.length > 0 ? 'Edible food available in inventory' : 'No edible food in inventory');
          recommendedActionType = edibleItems.length > 0 ? 'EAT_FOOD' : 'RETREAT_AND_RECOVER';
        } else {
          rootCause = `Starvation threshold reached (${food}/20) - sprint disabled`;
          confidence = 0.95;
          contributingFactors.push(`Food reserves: ${edibleItems.length} items`);
          recommendedActionType = edibleItems.length > 0 ? 'EAT_FOOD' : 'FIND_EMERGENCY_FOOD';
        }
        break;
      }

      case PROBLEM_TYPES.THREAT_INTERRUPTED: {
        category = ROOT_CAUSE_CATEGORIES.HOSTILE_THREAT_PRESSURE;
        rootCause = 'Active hostile mob within lethal combat or line-of-sight range';
        confidence = 0.95;
        contributingFactors.push(`Damage taken: ${problem.details?.damageTaken || 0}`);
        recommendedActionType = 'TACTICAL_RETREAT_OR_DEFENSE';
        break;
      }

      case PROBLEM_TYPES.RESOURCE_NOT_FOUND: {
        category = ROOT_CAUSE_CATEGORIES.RESOURCE_DEPLETED_OR_ABSENT;
        const targetRes = problem.details?.resource || 'resource';
        rootCause = `Resource '${targetRes}' not present within local search volume (search radius exhausted)`;
        confidence = 0.95;
        contributingFactors.push(`Target: ${targetRes}`, `Location: (${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)})`);
        recommendedActionType = 'SWITCH_RESOURCE_OR_EXPLORE';
        break;
      }

      case PROBLEM_TYPES.CRAFTING_BLOCKED: {
        category = ROOT_CAUSE_CATEGORIES.MISSING_WORKSTATION_OR_TOOL;
        const hasTableInInv = inventory.some(i => i.name === 'crafting_table');
        const planksInInv = inventory.filter(i => i.name.includes('plank')).reduce((s, i) => s + (i.count || 1), 0);
        rootCause = 'Crafting recipe requires a 3x3 crafting table block within interaction distance';
        confidence = 0.98;
        contributingFactors.push(hasTableInInv ? 'Crafting table present in inventory' : (planksInInv >= 4 ? 'Can craft crafting table from planks' : 'Planks needed for crafting table'));
        recommendedActionType = hasTableInInv ? 'PLACE_CRAFTING_TABLE' : (planksInInv >= 4 ? 'CRAFT_TABLE_FIRST' : 'GATHER_WOOD_FOR_TABLE');
        break;
      }

      case PROBLEM_TYPES.PREREQUISITE_MISSING: {
        category = ROOT_CAUSE_CATEGORIES.RECIPE_INGREDIENT_SHORTAGE;
        rootCause = `Insufficient crafting ingredients for '${problem.details?.item || 'item'}'`;
        confidence = 0.95;
        contributingFactors.push(`Item target: ${problem.details?.item}`);
        recommendedActionType = 'RESOLVE_INGREDIENT_PREREQUISITES';
        break;
      }

      case PROBLEM_TYPES.BLOCK_PLACEMENT_FAILED: {
        const isEntityCollision = problem.evidence.includes('player') || problem.evidence.includes('entity') || problem.evidence.includes('PLAYER_OBSTRUCTION');
        if (isEntityCollision) {
          category = ROOT_CAUSE_CATEGORIES.ENTITY_COLLISION_OBSTRUCTION;
          rootCause = 'Block placement target space is obstructed by player or living entity';
          confidence = 0.92;
          recommendedActionType = 'STEP_BACK_AND_REALIGN';
        } else {
          category = ROOT_CAUSE_CATEGORIES.PHYSICAL_BLOCK_OBSTRUCTION;
          rootCause = 'Target block face unavailable or target coordinate already occupied';
          confidence = 0.88;
          recommendedActionType = 'RETRY_ALTERNATE_FACE_OR_CLEAR';
        }
        break;
      }

      case PROBLEM_TYPES.NAVIGATION_BLOCKED: {
        category = ROOT_CAUSE_CATEGORIES.TERRAIN_UNREACHABLE_OR_HAZARD;
        rootCause = 'Pathfinding could not find a safe traversal path to target coordinates within time budget';
        confidence = 0.90;
        contributingFactors.push(`Destination: ${JSON.stringify(problem.details?.target || {})}`);
        recommendedActionType = 'REPATH_VIA_INTERMEDIATE_WAYPOINT';
        break;
      }

      case PROBLEM_TYPES.TASK_STAGNATION: {
        category = ROOT_CAUSE_CATEGORIES.REPEATED_ACTION_THRASHING;
        rootCause = `Execution loop stuck on failing action '${problem.details?.taskKey}' without world state progression`;
        confidence = 0.95;
        contributingFactors.push(`Consecutive failures: ${problem.details?.consecutiveFailures}`);
        recommendedActionType = 'APPLY_BACKOFF_AND_UNBLOCK';
        break;
      }

      default: {
        if (problem.evidence && (problem.evidence.includes('OUT_OF_BUILDING_MATERIALS') || problem.evidence.includes('building blocks'))) {
          category = ROOT_CAUSE_CATEGORIES.RESOURCE_DEPLETED_OR_ABSENT;
          rootCause = 'Building blocks exhausted; construction paused until materials gathered';
          confidence = 0.95;
          contributingFactors.push('Inventory lacks required construction blocks');
          recommendedActionType = 'GATHER_BUILDING_MATERIALS';
        } else {
          category = ROOT_CAUSE_CATEGORIES.UNKNOWN_OR_UNSPECIFIED;
          rootCause = problem.evidence || 'Unspecified execution failure';
          confidence = 0.70;
          recommendedActionType = 'FALLBACK_REFLEX';
        }
        break;
      }
    }

    const diagnosisRecord = {
      hasDiagnosis: true,
      timestamp: new Date().toISOString(),
      problemType: problem.problemType,
      severity: problem.severity,
      category,
      rootCause,
      confidence,
      recommendedActionType,
      contributingFactors,
      context: {
        health,
        food,
        position: { x: Math.round(pos.x * 10) / 10, y: Math.round(pos.y * 10) / 10, z: Math.round(pos.z * 10) / 10 },
        inventoryItemCount: inventory.length,
        currentTask
      }
    };

    this.history.push(diagnosisRecord);
    return diagnosisRecord;
  }
}

export const defaultProblemDiagnostician = new ProblemDiagnostician();
export default defaultProblemDiagnostician;
