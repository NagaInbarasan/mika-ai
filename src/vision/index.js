import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import MinecraftCamera from './camera.js';
import VisionFusionEngine from './fusion.js';
import VisualTargetSelector from './target-selector.js';
import VisualTargetingController from './targeting.js';
import VisualExperienceLogger from './logger.js';

const execFileAsync = promisify(execFile);

/**
 * MIKA V1.3 - Computer Vision & Visual Targeting Subsystem
 * Orchestrates camera capture, pretrained computer-vision inference,
 * cross-modal fusion, goal-conditioned target selection, and safe visual execution.
 */
export class MikaVisionEngine {
  constructor(options = {}) {
    this.pythonPath = options.pythonPath || 'py';
    this.pythonArgs = options.pythonArgs || ['-3.10'];
    this.detectorScript = options.detectorScript || path.join(process.cwd(), 'src', 'vision', 'detector.py');
    this.inferenceTimeoutMs = options.inferenceTimeoutMs || 12000;
    this.minConfidence = options.minConfidence || 0.55;

    this.camera = new MinecraftCamera(options.camera);
    this.fusion = new VisionFusionEngine(options.fusion);
    this.selector = new VisualTargetSelector(options.selector);
    this.targeting = new VisualTargetingController(options.targeting);
    this.logger = new VisualExperienceLogger(options.logger);
  }

  /**
   * Runs computer vision inference on an image file asynchronously.
   * If inference fails or times out, returns fallback indicator.
   * @param {string} imagePath
   * @returns {Promise<{ detections: Array, latency_ms: number, gpu_vram_mb: number, fallback: boolean }>}
   */
  async runInferenceAsync(imagePath) {
    const startTime = Date.now();
    try {
      const args = [...this.pythonArgs, this.detectorScript, '--image', imagePath, '--min-conf', String(this.minConfidence)];
      const { stdout } = await execFileAsync(this.pythonPath, args, {
        timeout: this.inferenceTimeoutMs,
        maxBuffer: 10 * 1024 * 1024
      });

      const parsed = JSON.parse(stdout.trim());
      return {
        detections: parsed.detections || [],
        latency_ms: parsed.inference_latency_ms || (Date.now() - startTime),
        gpu_vram_mb: parsed.gpu_vram_mb || 0,
        device: parsed.device || 'unknown',
        fallback: false
      };
    } catch (err) {
      console.warn(`[VisionEngine] Async inference failed (${err.message}). Using Mineflayer fallback.`);
      return {
        detections: [],
        latency_ms: Date.now() - startTime,
        gpu_vram_mb: 0,
        fallback: true,
        error: err.message
      };
    }
  }

  /**
   * Primary V1.3 Task:
   * Visually identify a tree, target its trunk, collect wood, and verify inventory change.
   *
   * @param {import('mineflayer').Bot} bot
   * @param {Object} [options]
   * @returns {Promise<Object>} Execution result
   */
  async executeVisualTreeHarvest(bot, options = {}) {
    const stepStartTime = Date.now();
    console.log('[Vision V1.3] Initiating visual tree harvest task...');

    // 1. Capture perspective screenshot
    const capture = this.camera.captureScreenshot(bot, {
      saveToDisk: true,
      lowDetail: options.fastMode || false
    });

    // 2. Run Pretrained Computer Vision Inference (Asynchronously)
    let visionResult;
    if (capture.framePath) {
      visionResult = await this.runInferenceAsync(capture.framePath);
    } else {
      visionResult = { detections: [], fallback: true };
    }

    let detections = visionResult.detections || [];
    let fallbackUsed = visionResult.fallback;

    // 3. Cross-Modal Fusion: Map 2D visual detections to 3D world coordinates
    const { fusedTargets, metrics } = this.fusion.fuseVisualWithWorld(detections, bot, capture.cameraState);

    // 4. Target Selection: Select the highest-scoring tree trunk
    let chosenTarget = this.selector.selectBestTarget(fusedTargets, 'GATHER_WOOD_LOGS', {
      botPosition: bot.entity?.position || { x: 0, y: 64, z: 0 },
      threats: bot.threats || [],
      inventory: (typeof bot.inventory?.items === 'function' ? bot.inventory.items() : bot.inventory) || []
    });

    // 5. Graceful Fallback to Mineflayer ground-truth if vision returned no valid trunk
    if (!chosenTarget || chosenTarget.class !== 'tree_trunk') {
      console.log('[Vision V1.3] No high-confidence visual trunk found. Invoking Mineflayer fallback search...');
      fallbackUsed = true;
      const fallbackTarget = this.findMineflayerFallbackTrunk(bot);
      if (fallbackTarget) {
        chosenTarget = fallbackTarget;
      }
    }

    if (!chosenTarget) {
      const failOutcome = {
        success: false,
        reason: 'No reachable tree trunk found via computer vision or fallback search',
        durationMs: Date.now() - stepStartTime
      };
      this.logger.logExperience({
        camera: capture.cameraState,
        detections,
        chosen_target: null,
        action: 'harvest_tree_trunk',
        actionAttempted: false,
        outcome: failOutcome,
        accuracy: metrics,
        latency_ms: visionResult.latency_ms,
        gpu_vram_mb: visionResult.gpu_vram_mb
      });
      return failOutcome;
    }

    console.log(`[Vision V1.3] Selected Target: ${chosenTarget.class} (${chosenTarget.id || 'fallback'}) at (${chosenTarget.worldPos.x}, ${chosenTarget.worldPos.y}, ${chosenTarget.worldPos.z}) | Distance: ${chosenTarget.distance}m | Conf: ${chosenTarget.confidence || 1.0}`);

    // 6. Safe Visual Targeting: Align, verify range, execute harvest, confirm inventory delta
    const harvestResult = await this.targeting.executeVisualHarvest(bot, chosenTarget);

    console.log(`[Vision V1.3] Harvest Result: ${harvestResult.success ? 'SUCCESS' : 'FAILED'} | ${harvestResult.reason}`);

    // 7. Log Experience & Update Evaluation Report
    this.logger.logExperience({
      camera: capture.cameraState,
      detections,
      chosen_target: chosenTarget,
      action: 'harvest_tree_trunk',
      actionAttempted: true,
      outcome: harvestResult,
      accuracy: metrics,
      latency_ms: visionResult.latency_ms,
      gpu_vram_mb: visionResult.gpu_vram_mb
    });

    const report = this.logger.generateReport();

    return {
      success: harvestResult.success,
      target: chosenTarget,
      outcome: harvestResult,
      fallbackUsed,
      detectionMetrics: metrics,
      inferenceLatencyMs: visionResult.latency_ms,
      gpuVramMb: visionResult.gpu_vram_mb,
      report
    };
  }

  /**
   * Deterministic Mineflayer fallback when visual detection is unavailable.
   */
  findMineflayerFallbackTrunk(bot) {
    if (!bot || !bot.findBlock) return null;

    try {
      const logBlock = bot.findBlock({
        matching: (b) => b && (b.name.includes('log') || b.name.includes('wood')),
        maxDistance: 16
      });

      if (!logBlock) return null;

      const botPos = bot.entity ? bot.entity.position : { x: 0, y: 64, z: 0 };
      const dist = Math.hypot(
        logBlock.position.x - botPos.x,
        logBlock.position.y - botPos.y,
        logBlock.position.z - botPos.z
      );

      return {
        id: 'fallback-trunk-1',
        class: 'tree_trunk',
        confidence: 0.85,
        worldPos: {
          x: logBlock.position.x + 0.5,
          y: logBlock.position.y + 0.5,
          z: logBlock.position.z + 0.5
        },
        distance: Math.round(dist * 10) / 10,
        score: 15.0,
        matchedBlock: logBlock.name,
        isVerified: true
      };
    } catch (_) {
      return null;
    }
  }
}

export default MikaVisionEngine;
