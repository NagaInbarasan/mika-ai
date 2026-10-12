/**
 * Scripted Deterministic Baseline Planner.
 * Operates purely on fixed heuristics without calling the LLM,
 * serving as a control benchmark to evaluate Qwen 3.5 9B.
 */
export class ScriptedBaselinePlanner {
  constructor() {
    this.name = 'scripted_baseline';
  }

  /**
   * Generates a heuristic action for a specific task.
   * @param {Object} params
   * @param {Object} params.observation - Current world snapshot
   * @param {string} params.taskType - e.g. 'gather_resource', 'navigate_and_return', 'hazard_avoidance'
   * @param {Object} params.taskTarget - e.g. { resource: 'sand', count: 3 }
   * @returns {Object} Deterministic decision object
   */
  proposeAction({ observation, taskType, taskTarget = {} }) {
    if (!observation || !observation.agent) {
      return { action: 'stop', arguments: {}, goal: 'idle', reason_summary: 'No observation available' };
    }

    const agent = observation.agent;

    switch (taskType) {
      case 'gather_resource': {
        const targetRes = taskTarget.resource || 'sand';
        const nearbyRes = (observation.nearby_resources || []).find(r => r.name === targetRes);

        if (nearbyRes) {
          return {
            goal: `gather ${targetRes}`,
            action: 'collect_resource',
            arguments: { resource: targetRes },
            reason_summary: `Heuristic: Target resource '${targetRes}' found ${nearbyRes.distance}m away.`,
            expected_outcome: `inventory ${targetRes} increases`,
            risk: 'low',
            confidence: 1.0
          };
        } else {
          // If no resource seen, look around to refresh field of view
          return {
            goal: `search for ${targetRes}`,
            action: 'look_around',
            arguments: { yaw: agent.yaw + (Math.PI / 2) },
            reason_summary: `Heuristic: '${targetRes}' not in view; rotating gaze.`,
            expected_outcome: 'expanded field of view',
            risk: 'low',
            confidence: 0.8
          };
        }
      }

      case 'navigate_and_return': {
        const dest = taskTarget.destination || { x: agent.position.x + 5, z: agent.position.z };
        return {
          goal: 'navigate to target coordinate',
          action: 'navigate_to',
          arguments: { x: dest.x, y: dest.y, z: dest.z, range: 1.5 },
          reason_summary: `Heuristic: Direct waypoint pathfinding.`,
          expected_outcome: 'position reaches destination',
          risk: 'low',
          confidence: 1.0
        };
      }

      case 'hazard_avoidance': {
        const threat = (observation.nearby_threats || [])[0];
        if (threat) {
          const retreatX = Math.round(agent.position.x + (agent.position.x - threat.position.x) * 2);
          const retreatZ = Math.round(agent.position.z + (agent.position.z - threat.position.z) * 2);
          return {
            goal: 'retreat from threat',
            action: 'navigate_to',
            arguments: { x: retreatX, z: retreatZ, range: 2.0 },
            reason_summary: `Heuristic: Retreat opposite to threat ${threat.name}.`,
            expected_outcome: 'distance to threat increases',
            risk: 'medium',
            confidence: 0.9
          };
        }
        return {
          goal: 'safe idle',
          action: 'stop',
          arguments: {},
          reason_summary: 'Heuristic: No threats in range.',
          expected_outcome: 'remain idle',
          risk: 'low',
          confidence: 1.0
        };
      }

      default:
        return {
          goal: 'inspect inventory',
          action: 'inspect_inventory',
          arguments: {},
          reason_summary: 'Heuristic default fallback',
          expected_outcome: 'inventory state refreshed',
          risk: 'low',
          confidence: 1.0
        };
    }
  }
}

export const defaultBaselinePlanner = new ScriptedBaselinePlanner();
export default defaultBaselinePlanner;
