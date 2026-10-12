import { ROOT_CAUSE_CATEGORIES } from './problem-diagnostician.js';

/**
 * MIKA V1.3 — Resolution Planner
 * 
 * Generates and ranks actionable recovery plans for diagnosed problems.
 * Evaluates constraints, inventory state, and execution cost to choose the best solution.
 */

export class ResolutionPlanner {
  constructor(options = {}) {}

  /**
   * Plans recovery solutions for a given diagnosis.
   * 
   * @param {Object} params
   * @param {Object} params.diagnosis - Diagnosis record from ProblemDiagnostician
   * @param {import('mineflayer').Bot} [params.bot]
   * @param {Object} [params.worldState]
   * @returns {Array<Object>} Ranked list of candidate resolution plans
   */
  generateResolutionPlans({ diagnosis, bot = null, worldState = {} }) {
    if (!diagnosis || !diagnosis.hasDiagnosis) {
      return [];
    }

    const plans = [];
    const inventory = bot?.inventory?.items ? bot.inventory.items() : (worldState.inventory?.items || []);
    const health = bot?.health ?? worldState.agent?.health ?? 20;
    const food = bot?.food ?? worldState.agent?.food ?? 20;

    switch (diagnosis.category) {
      // 1. Critical Health or Hunger
      case ROOT_CAUSE_CATEGORIES.CRITICAL_HEALTH_OR_HUNGER: {
        const foodItem = inventory.find(i => ['bread', 'cooked_beef', 'apple', 'baked_potato', 'carrot', 'sweet_berries'].some(k => i.name.includes(k)));
        if (foodItem) {
          plans.push({
            id: 'plan_eat_inventory_food',
            strategy: `Consume '${foodItem.name}' from inventory to restore hunger and trigger health regeneration`,
            action: 'eat_food',
            args: { item: foodItem.name },
            confidence: 0.95,
            cost: 'low',
            expectedOutcome: 'Hunger restored and health regeneration begins'
          });
        }
        plans.push({
          id: 'plan_tactical_retreat_heal',
          strategy: 'Retreat to safe perimeter (>16m) and enter defensive posture to heal',
          action: 'retreat_and_heal',
          args: {},
          confidence: 0.88,
          cost: 'medium',
          expectedOutcome: 'Distance created from hostiles and health safely restored'
        });
        break;
      }

      // 2. Hostile Threat Pressure
      case ROOT_CAUSE_CATEGORIES.HOSTILE_THREAT_PRESSURE: {
        const hasShield = inventory.some(i => i.name.includes('shield'));
        if (hasShield) {
          plans.push({
            id: 'plan_raise_shield',
            strategy: 'Raise shield to block incoming strikes and evaluate retreat path',
            action: 'defend_with_shield',
            args: { duration_ms: 2000 },
            confidence: 0.92,
            cost: 'low',
            expectedOutcome: 'Incoming damage mitigated'
          });
        }
        plans.push({
          id: 'plan_flee_threat',
          strategy: 'Tactical retreat to safe distance or fortified shelter',
          action: 'retreat_and_heal',
          args: {},
          confidence: 0.90,
          cost: 'medium',
          expectedOutcome: 'Threat evaded'
        });
        break;
      }

      // 3. Resource Depleted or Absent (e.g. sweet_berries 906 failures)
      case ROOT_CAUSE_CATEGORIES.RESOURCE_DEPLETED_OR_ABSENT: {
        // Plan A: Switch to abundant alternative resource in environment
        plans.push({
          id: 'plan_substitute_dirt_blocks',
          strategy: 'Substitute scarce resource with abundant surface material (dirt/grass)',
          action: 'collect_resource',
          args: { resource: 'dirt', count: 4 },
          confidence: 0.92,
          cost: 'low',
          expectedOutcome: 'Building blocks gathered without getting stuck on scarce resource'
        });
        // Plan B: Clear stagnation and unblock
        plans.push({
          id: 'plan_reposition_for_resources',
          strategy: 'Relocate 16 blocks to new biome/chunk area with fresh resource density',
          action: 'navigate_to',
          args: { x: (bot?.entity?.position?.x || 0) + 16, z: (bot?.entity?.position?.z || 0) + 16 },
          confidence: 0.80,
          cost: 'medium',
          expectedOutcome: 'Arrive in unharvested terrain'
        });
        break;
      }

      // 4. Missing Workstation (Crafting Table required)
      case ROOT_CAUSE_CATEGORIES.MISSING_WORKSTATION_OR_TOOL: {
        const tableItem = inventory.find(i => i.name === 'crafting_table');
        if (tableItem) {
          const pos = bot?.entity?.position || { x: 0, y: 64, z: 0 };
          plans.push({
            id: 'plan_place_inventory_crafting_table',
            strategy: 'Place crafting table from inventory on ground to unlock 3x3 recipe grid',
            action: 'place_block',
            args: { block: 'crafting_table', x: Math.floor(pos.x) + 1, y: Math.floor(pos.y), z: Math.floor(pos.z) },
            confidence: 0.95,
            cost: 'low',
            expectedOutcome: 'Crafting table deployed and accessible'
          });
        } else {
          plans.push({
            id: 'plan_craft_crafting_table_first',
            strategy: 'Convert wood logs/planks into a crafting table in 2x2 player grid',
            action: 'craft_item',
            args: { item: 'crafting_table', count: 1 },
            confidence: 0.90,
            cost: 'low',
            expectedOutcome: 'Crafting table acquired'
          });
        }
        break;
      }

      // 5. Recipe Ingredient Shortage
      case ROOT_CAUSE_CATEGORIES.RECIPE_INGREDIENT_SHORTAGE: {
        plans.push({
          id: 'plan_gather_base_wood',
          strategy: 'Gather wood logs to satisfy tool/recipe crafting prerequisites',
          action: 'collect_resource',
          args: { resource: 'wood', count: 3 },
          confidence: 0.90,
          cost: 'medium',
          expectedOutcome: 'Logs in inventory ready for conversion'
        });
        break;
      }

      // 6. Block Placement Obstructed
      case ROOT_CAUSE_CATEGORIES.ENTITY_COLLISION_OBSTRUCTION:
      case ROOT_CAUSE_CATEGORIES.PHYSICAL_BLOCK_OBSTRUCTION: {
        const pos = bot?.entity?.position || { x: 0, y: 64, z: 0 };
        plans.push({
          id: 'plan_step_back_and_retry',
          strategy: 'Step back 1.5 blocks and attempt placement from clear vantage point',
          action: 'navigate_to',
          args: { x: Math.floor(pos.x) - 1, z: Math.floor(pos.z) - 1, range: 0.5 },
          confidence: 0.88,
          cost: 'low',
          expectedOutcome: 'Collision cleared'
        });
        break;
      }

      // 7. Navigation Unreachable
      case ROOT_CAUSE_CATEGORIES.TERRAIN_UNREACHABLE_OR_HAZARD: {
        plans.push({
          id: 'plan_look_around_repath',
          strategy: 'Survey surroundings and re-evaluate path with intermediate waypoint',
          action: 'look_around',
          args: { yaw: 0, pitch: 0 },
          confidence: 0.85,
          cost: 'low',
          expectedOutcome: 'Pathfinder re-initialized'
        });
        break;
      }

      // 8. Repeated Action Thrashing / Stagnation
      case ROOT_CAUSE_CATEGORIES.REPEATED_ACTION_THRASHING: {
        plans.push({
          id: 'plan_halt_and_switch_objective',
          strategy: 'Halt failing action, clear retry counters, and switch to alternative priority',
          action: 'look_around',
          args: { yaw: 1.57, pitch: 0 },
          confidence: 0.95,
          cost: 'low',
          expectedOutcome: 'Thrashing loop broken'
        });
        break;
      }

      default: {
        plans.push({
          id: 'plan_inspect_and_reset',
          strategy: 'Inspect inventory and reset task state to clear transient failure',
          action: 'inspect_inventory',
          args: {},
          confidence: 0.80,
          cost: 'low',
          expectedOutcome: 'State synchronized'
        });
        break;
      }
    }

    // Sort plans descending by confidence
    plans.sort((a, b) => b.confidence - a.confidence);
    return plans;
  }
}

export const defaultResolutionPlanner = new ResolutionPlanner();
export default defaultResolutionPlanner;
