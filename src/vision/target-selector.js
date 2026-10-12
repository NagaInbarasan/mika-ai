/**
 * MIKA Visual Target Selection System
 * Chooses objects based on MIKA's current goal, distance, danger, and resource needs.
 */

export const GOAL_CLASS_AFFINITIES = {
  GATHER_WOOD_LOGS: { targetClass: 'tree_trunk', priority: 10.0 },
  COLLECT_WOOD: { targetClass: 'tree_trunk', priority: 10.0 },
  WOOD_GATHERING: { targetClass: 'tree_trunk', priority: 10.0 },
  BUILD_SHELTER: { targetClass: 'structure', priority: 8.0, fallbackClass: 'tree_trunk' },
  GATHER_FOOD: { targetClass: 'animal', priority: 9.0 },
  HUNT_ANIMAL: { targetClass: 'animal', priority: 10.0 },
  MINE_ORE: { targetClass: 'ore', priority: 10.0 },
  DEFEND: { targetClass: 'hostile_mob', priority: 10.0 },
  COMBAT: { targetClass: 'hostile_mob', priority: 10.0 }
};

export class VisualTargetSelector {
  constructor(options = {}) {
    this.minConfidence = options.minConfidence || 0.60;
    this.maxInteractionDistance = options.maxInteractionDistance || 18.0;
    this.dangerSafetyRadius = options.dangerSafetyRadius || 6.5;
  }

  /**
   * Evaluates and selects the highest-utility target from fused visual detections.
   * @param {Array<Object>} fusedTargets
   * @param {string} currentGoal
   * @param {Object} context - { botPosition, threats, inventory }
   * @returns {Object|null} Best target or null if no viable target found
   */
  selectBestTarget(fusedTargets, currentGoal = 'GATHER_WOOD_LOGS', context = {}) {
    if (!fusedTargets || fusedTargets.length === 0) {
      return null;
    }

    const { botPosition = { x: 0, y: 64, z: 0 }, threats = [], inventory = [] } = context;
    const goalAffinity = GOAL_CLASS_AFFINITIES[currentGoal] || { targetClass: 'tree_trunk', priority: 5.0 };

    // Inventory need evaluation
    const woodCount = inventory.find(i => i.name?.includes('log') || i.name?.includes('wood'))?.count || 0;
    const needsWoodBoost = woodCount < 8 ? 2.5 : 1.0;

    const scoredTargets = [];

    for (const target of fusedTargets) {
      // 1. Minimum confidence filter
      if (target.confidence < this.minConfidence) {
        continue;
      }

      // 2. Maximum interaction distance filter
      const distance = target.distance || Math.hypot(
        target.worldPos.x - botPosition.x,
        target.worldPos.y - botPosition.y,
        target.worldPos.z - botPosition.z
      );

      if (distance > this.maxInteractionDistance) {
        continue;
      }

      // 3. Goal Match Score
      let goalMatchScore = 1.0;
      if (target.class === goalAffinity.targetClass) {
        goalMatchScore = goalAffinity.priority;
      } else if (goalAffinity.fallbackClass && target.class === goalAffinity.fallbackClass) {
        goalMatchScore = goalAffinity.priority * 0.7;
      } else {
        // Less relevant to current goal
        goalMatchScore = 0.5;
      }

      // 4. Proximity Score (closer is significantly better)
      const proximityScore = 10.0 / (1.0 + distance);

      // 5. Danger / Threat Penalty
      let dangerPenalty = 0.0;
      if (target.class !== 'hostile_mob' && threats.length > 0) {
        for (const threat of threats) {
          const threatPos = threat.position || threat.pos || { x: 999, y: 999, z: 999 };
          const distToThreat = Math.hypot(
            target.worldPos.x - threatPos.x,
            target.worldPos.y - threatPos.y,
            target.worldPos.z - threatPos.z
          );
          if (distToThreat < this.dangerSafetyRadius) {
            dangerPenalty += (this.dangerSafetyRadius - distToThreat) * 3.0;
          }
        }
      }

      // 6. Verification Boost (cross-checked with Mineflayer voxel ground-truth)
      const verificationBoost = target.isVerified ? 3.0 : 0.0;

      // Composite Utility Score
      const totalScore = (goalMatchScore * 3.0 * needsWoodBoost) +
                         (proximityScore * 2.0) +
                         (target.confidence * 4.0) +
                         verificationBoost -
                         dangerPenalty;

      scoredTargets.push({
        ...target,
        score: Math.round(totalScore * 100) / 100,
        distance: Math.round(distance * 10) / 10,
        breakdown: {
          goalMatchScore,
          proximityScore: Math.round(proximityScore * 10) / 10,
          confidenceScore: target.confidence,
          dangerPenalty: Math.round(dangerPenalty * 10) / 10,
          verificationBoost
        }
      });
    }

    if (scoredTargets.length === 0) {
      return null;
    }

    // Sort descending by score
    scoredTargets.sort((a, b) => b.score - a.score);
    return scoredTargets[0];
  }
}

export default VisualTargetSelector;
