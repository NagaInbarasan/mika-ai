/**
 * MIKA Cross-Modal Vision Fusion & Coordinate Projection
 * Maps 2D screen bounding boxes to 3D world space coordinates,
 * associates visual detections with Mineflayer's structured block data,
 * and evaluates detection accuracy (Precision, Recall, False Positives).
 */

export const CLASS_TO_MINECRAFT_BLOCKS = {
  tree_trunk: ['oak_log', 'birch_log', 'spruce_log', 'dark_oak_log', 'acacia_log', 'jungle_log', 'oak_wood', 'log'],
  tree_foliage: ['oak_leaves', 'birch_leaves', 'spruce_leaves', 'leaves'],
  ore: ['coal_ore', 'iron_ore', 'copper_ore', 'gold_ore', 'diamond_ore', 'lapis_ore', 'redstone_ore'],
  water: ['water'],
  structure: ['crafting_table', 'chest', 'furnace', 'bed', 'oak_planks', 'planks', 'door']
};

export class VisionFusionEngine {
  constructor(options = {}) {
    this.maxRayRange = options.maxRayRange || 24.0;
    this.history = {
      truePositives: 0,
      falsePositives: 0,
      falseNegatives: 0,
      totalDetections: 0
    };
  }

  /**
   * Unprojects normalized 2D screen coordinates (nx, ny in [0, 1]) to a 3D ray direction vector.
   * @param {number} nx - Normalized X (0 = left, 1 = right)
   * @param {number} ny - Normalized Y (0 = top, 1 = bottom)
   * @param {Object} cameraState - { position, yaw, pitch, fov, width, height }
   * @returns {{ x: number, y: number, z: number }} Ray unit direction vector
   */
  unprojectScreenToRay(nx, ny, cameraState) {
    const { yaw, pitch, fov } = cameraState;
    const aspect = (cameraState.width || 320) / (cameraState.height || 240);
    const fovRad = (fov * Math.PI) / 180.0;
    const halfFovX = fovRad / 2.0;
    const halfFovY = halfFovX / aspect;

    const screenX = nx * 2.0 - 1.0;  // -1 (left) to +1 (right)
    const screenY = 1.0 - ny * 2.0;  // +1 (top) to -1 (bottom)

    const rayOffsetX = screenX * Math.tan(halfFovX);
    const rayOffsetY = screenY * Math.tan(halfFovY);

    const forward = {
      x: -Math.sin(yaw) * Math.cos(pitch),
      y: -Math.sin(pitch),
      z: Math.cos(yaw) * Math.cos(pitch)
    };

    const right = {
      x: Math.cos(yaw),
      y: 0,
      z: Math.sin(yaw)
    };

    const up = {
      x: right.y * forward.z - right.z * forward.y,
      y: right.z * forward.x - right.x * forward.z,
      z: right.x * forward.y - right.y * forward.x
    };

    const dir = {
      x: forward.x + right.x * rayOffsetX + up.x * rayOffsetY,
      y: forward.y + right.y * rayOffsetX + up.y * rayOffsetY,
      z: forward.z + right.z * rayOffsetX + up.z * rayOffsetY
    };

    const len = Math.hypot(dir.x, dir.y, dir.z) || 1.0;
    return {
      x: dir.x / len,
      y: dir.y / len,
      z: dir.z / len
    };
  }

  /**
   * Combines visual detections with Mineflayer's live block & entity state.
   * @param {Array<Object>} detections - Detections from vision model
   * @param {import('mineflayer').Bot} bot - Mineflayer bot instance
   * @param {Object} cameraState - Camera state used during capture
   * @returns {{ fusedTargets: Array<Object>, metrics: Object }}
   */
  fuseVisualWithWorld(detections, bot, cameraState) {
    const fusedTargets = [];
    const eyePos = cameraState.position || (bot.entity ? {
      x: bot.entity.position.x,
      y: bot.entity.position.y + (bot.entity.height || 1.62),
      z: bot.entity.position.z
    } : { x: 0, y: 64, z: 0 });

    let stepTP = 0;
    let stepFP = 0;

    for (const det of detections) {
      this.history.totalDetections++;
      const [nx, ny] = det.normalized_center || [0.5, 0.5];
      const ray = this.unprojectScreenToRay(nx, ny, cameraState);

      // Raycast to find intersected block in Mineflayer world
      const hit = this.raycastBlock(bot, eyePos, ray);

      let isVerified = false;
      let matchedBlock = null;

      if (hit && hit.block) {
        matchedBlock = hit.block.name;
        const validBlocks = CLASS_TO_MINECRAFT_BLOCKS[det.class] || [];
        
        // Check if hit block matches detection class
        if (validBlocks.some(b => matchedBlock.includes(b)) || (det.class === 'tree_trunk' && matchedBlock.includes('log'))) {
          isVerified = true;
          stepTP++;
          this.history.truePositives++;
        } else {
          stepFP++;
          this.history.falsePositives++;
        }
      } else {
        stepFP++;
        this.history.falsePositives++;
      }

      const distance = hit ? hit.distance : 999.0;
      const worldPos = hit ? hit.pos : {
        x: eyePos.x + ray.x * 4.0,
        y: eyePos.y + ray.y * 4.0,
        z: eyePos.z + ray.z * 4.0
      };

      fusedTargets.push({
        id: det.id,
        class: det.class,
        confidence: det.confidence,
        bbox: det.bbox,
        normalized_bbox: det.normalized_bbox,
        center: det.center,
        normalized_center: det.normalized_center,
        worldPos: {
          x: Math.round(worldPos.x * 10) / 10,
          y: Math.round(worldPos.y * 10) / 10,
          z: Math.round(worldPos.z * 10) / 10
        },
        distance: Math.round(distance * 10) / 10,
        matchedBlock,
        isVerified,
        ray
      });
    }

    // Check for missed targets (ground-truth targets in FOV that detector missed)
    const missedTargets = this.findMissedGroundTruth(bot, eyePos, cameraState, fusedTargets);
    this.history.falseNegatives += missedTargets.length;

    const precision = (this.history.truePositives + this.history.falsePositives) > 0
      ? this.history.truePositives / (this.history.truePositives + this.history.falsePositives)
      : 1.0;

    const recall = (this.history.truePositives + this.history.falseNegatives) > 0
      ? this.history.truePositives / (this.history.truePositives + this.history.falseNegatives)
      : 1.0;

    return {
      fusedTargets,
      metrics: {
        stepTruePositives: stepTP,
        stepFalsePositives: stepFP,
        stepMissedTargets: missedTargets.length,
        cumulativeTruePositives: this.history.truePositives,
        cumulativeFalsePositives: this.history.falsePositives,
        cumulativeFalseNegatives: this.history.falseNegatives,
        precision: Math.round(precision * 1000) / 1000,
        recall: Math.round(recall * 1000) / 1000
      }
    };
  }

  /**
   * Raycasts through the Mineflayer block space.
   */
  raycastBlock(bot, origin, dir) {
    if (!bot || !bot.blockAt) return null;

    const stepSize = 0.25;
    const maxSteps = Math.floor(this.maxRayRange / stepSize);

    for (let i = 1; i <= maxSteps; i++) {
      const rx = origin.x + dir.x * (i * stepSize);
      const ry = origin.y + dir.y * (i * stepSize);
      const rz = origin.z + dir.z * (i * stepSize);

      const pos = {
        x: Math.floor(rx),
        y: Math.floor(ry),
        z: Math.floor(rz)
      };

      try {
        const block = bot.blockAt(pos);
        if (block && block.name && block.name !== 'air' && block.name !== 'cave_air') {
          const dist = Math.hypot(rx - origin.x, ry - origin.y, rz - origin.z);
          return {
            pos,
            block,
            distance: dist
          };
        }
      } catch (_) {
        break;
      }
    }
    return null;
  }

  /**
   * Detects nearby ground-truth objects in FOV that vision detection missed.
   */
  findMissedGroundTruth(bot, eyePos, cameraState, fusedTargets) {
    if (!bot || !bot.findBlocks) return [];

    const missed = [];
    try {
      // Check for tree trunks within 12m
      const logIds = [
        bot.registry?.blocksByName?.oak_log?.id,
        bot.registry?.blocksByName?.birch_log?.id,
        bot.registry?.blocksByName?.spruce_log?.id
      ].filter(Boolean);

      if (logIds.length > 0) {
        const logs = bot.findBlocks({
          matching: logIds,
          maxDistance: 12,
          count: 5
        });

        for (const logPos of logs) {
          // Check if log is in front of bot (in FOV)
          const dx = logPos.x - eyePos.x;
          const dz = logPos.z - eyePos.z;
          const angleToLog = Math.atan2(-dx, dz);
          let angleDiff = Math.abs(angleToLog - cameraState.yaw);
          while (angleDiff > Math.PI) angleDiff -= 2 * Math.PI;
          angleDiff = Math.abs(angleDiff);

          // If within 40 degrees (in FOV)
          if (angleDiff < (40 * Math.PI) / 180) {
            // Check if already covered by fused targets
            const covered = fusedTargets.some(t => {
              return t.class === 'tree_trunk' && Math.hypot(t.worldPos.x - logPos.x, t.worldPos.z - logPos.z) < 2.5;
            });
            if (!covered) {
              missed.push({
                class: 'tree_trunk',
                pos: logPos
              });
            }
          }
        }
      }
    } catch (_) {}

    return missed;
  }
}

export default VisionFusionEngine;
