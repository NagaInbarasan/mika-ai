import test from 'node:test';
import assert from 'node:assert';
import path from 'path';
import fs from 'fs';

import { MinecraftCamera, MINECRAFT_PALETTE } from '../src/vision/camera.js';
import { VisionFusionEngine } from '../src/vision/fusion.js';
import { VisualTargetSelector } from '../src/vision/target-selector.js';
import { VisualTargetingController } from '../src/vision/targeting.js';
import { VisualExperienceLogger } from '../src/vision/logger.js';
import { MikaVisionEngine } from '../src/vision/index.js';

// ============================================================================
// Test 1: Camera Viewport Capture & Raycasting
// ============================================================================
test('Vision: MinecraftCamera captures perspective viewport with camera state and RGB buffer', () => {
  const camera = new MinecraftCamera({ width: 160, height: 120, fov: 70 });
  
  const mockBot = {
    entity: {
      position: { x: 10, y: 64, z: 20 },
      height: 1.62,
      yaw: 0.0,    // Facing South (+Z)
      pitch: 0.0   // Horizon
    },
    blockAt: (pos) => {
      // Tree trunk 4 blocks directly in front
      if (pos.x === 10 && pos.z === 24 && pos.y >= 64 && pos.y <= 67) {
        return { name: 'oak_log' };
      }
      if (pos.y < 64) return { name: 'grass_block' };
      return { name: 'air' };
    }
  };

  const capture = camera.captureScreenshot(mockBot, { lowDetail: true });

  assert.strictEqual(capture.width, 160);
  assert.strictEqual(capture.height, 120);
  assert.strictEqual(capture.buffer.length, 160 * 120 * 3);
  assert.strictEqual(capture.cameraState.yaw, 0.0);
  assert.strictEqual(capture.cameraState.position.y, 65.62);

  // Ray directly ahead should hit oak_log
  const centerRay = { x: 0, y: 0, z: 1 };
  const color = camera.castRay(mockBot, capture.cameraState.position, centerRay);
  assert.deepStrictEqual(color, MINECRAFT_PALETTE.oak_log);
});

// ============================================================================
// Test 2: Pretrained Python Vision Detector Execution
// ============================================================================
test('Vision: Python detector identifies tree trunk with bounding box, confidence, and latency', async () => {
  const engine = new MikaVisionEngine({ inferenceTimeoutMs: 15000 });
  
  // Create a synthetic test image with a tree trunk
  const tmpDir = path.join(process.cwd(), 'data', 'vision', 'test');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  const testPpmPath = path.join(tmpDir, 'test_tree.ppm');
  
  const width = 160;
  const height = 120;
  const buffer = Buffer.alloc(width * height * 3);
  
  // Fill sky (blue) and ground (green)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 3;
      if (y < 60) {
        buffer[idx] = 110; buffer[idx + 1] = 160; buffer[idx + 2] = 240; // Sky
      } else {
        buffer[idx] = 60; buffer[idx + 1] = 160; buffer[idx + 2] = 45;   // Grass
      }
      // Tree trunk in center
      if (y >= 40 && y <= 95 && x >= 70 && x <= 90) {
        buffer[idx] = 105; buffer[idx + 1] = 75; buffer[idx + 2] = 45;   // Brown wood log
      }
    }
  }
  
  const header = `P6\n${width} ${height}\n255\n`;
  fs.writeFileSync(testPpmPath, Buffer.concat([Buffer.from(header, 'ascii'), buffer]));

  const result = await engine.runInferenceAsync(testPpmPath);

  assert.strictEqual(result.fallback, false);
  assert.ok(result.latency_ms > 0);
  assert.ok(result.detections.length > 0);

  const trunk = result.detections.find(d => d.class === 'tree_trunk');
  assert.ok(trunk, 'Expected tree_trunk detection in synthetic image');
  assert.ok(trunk.confidence >= 0.55);
  assert.strictEqual(trunk.bbox.length, 4);
  assert.strictEqual(trunk.normalized_bbox.length, 4);
  assert.ok(trunk.center[0] >= 65 && trunk.center[0] <= 95);
});

// ============================================================================
// Test 3: Cross-Modal 2D-to-3D Unprojection & Fusion
// ============================================================================
test('Vision: VisionFusionEngine unprojects screen bbox and validates against Mineflayer ground-truth', () => {
  const fusion = new VisionFusionEngine();
  
  const cameraState = {
    position: { x: 0, y: 65, z: 0 },
    yaw: 0.0,   // Facing South (+Z)
    pitch: 0.0,
    fov: 70.0,
    width: 320,
    height: 240
  };

  // Center unprojection (nx=0.5, ny=0.5) must point along forward ray (0, 0, 1)
  const centerRay = fusion.unprojectScreenToRay(0.5, 0.5, cameraState);
  assert.ok(Math.abs(centerRay.x) < 0.05);
  assert.ok(Math.abs(centerRay.y) < 0.05);
  assert.ok(centerRay.z > 0.95);

  const mockBot = {
    entity: { position: { x: 0, y: 64, z: 0 }, height: 1.62 },
    blockAt: (pos) => {
      // Oak log at z = 4
      if (pos.x === 0 && pos.z === 4 && pos.y === 65) {
        return { name: 'oak_log' };
      }
      return { name: 'air' };
    }
  };

  const detections = [
    {
      id: 'tree_trunk-1',
      class: 'tree_trunk',
      confidence: 0.92,
      bbox: [140, 100, 180, 140],
      normalized_bbox: [0.43, 0.41, 0.56, 0.58],
      center: [160, 120],
      normalized_center: [0.5, 0.5]
    }
  ];

  const { fusedTargets, metrics } = fusion.fuseVisualWithWorld(detections, mockBot, cameraState);

  assert.strictEqual(fusedTargets.length, 1);
  const target = fusedTargets[0];
  assert.strictEqual(target.isVerified, true);
  assert.strictEqual(target.matchedBlock, 'oak_log');
  assert.strictEqual(target.worldPos.z, 4);
  assert.strictEqual(metrics.stepTruePositives, 1);
  assert.strictEqual(metrics.precision, 1.0);
});

// ============================================================================
// Test 4: Goal-Conditioned Target Selection System
// ============================================================================
test('Vision: VisualTargetSelector chooses best target based on goal, proximity, and danger avoidance', () => {
  const selector = new VisualTargetSelector();

  const fusedTargets = [
    {
      id: 'tree-distant',
      class: 'tree_trunk',
      confidence: 0.90,
      worldPos: { x: 0, y: 64, z: 15 },
      distance: 15.0,
      isVerified: true
    },
    {
      id: 'tree-close-safe',
      class: 'tree_trunk',
      confidence: 0.88,
      worldPos: { x: 0, y: 64, z: 3.5 },
      distance: 3.5,
      isVerified: true
    },
    {
      id: 'tree-near-creeper',
      class: 'tree_trunk',
      confidence: 0.95,
      worldPos: { x: 8, y: 64, z: 4.0 },
      distance: 4.0,
      isVerified: true
    }
  ];

  const context = {
    botPosition: { x: 0, y: 64, z: 0 },
    threats: [
      { name: 'creeper', position: { x: 8, y: 64, z: 4.5 } } // Creeper 0.5m from 'tree-near-creeper'!
    ],
    inventory: []
  };

  const bestTarget = selector.selectBestTarget(fusedTargets, 'GATHER_WOOD_LOGS', context);

  // Must select the close, safe tree, avoiding the tree next to the creeper
  assert.ok(bestTarget);
  assert.strictEqual(bestTarget.id, 'tree-close-safe');
  assert.strictEqual(bestTarget.distance, 3.5);
  assert.ok(bestTarget.score > 0);
});

// ============================================================================
// Test 5: Safe Visual Targeting & Inventory Delta Verification
// ============================================================================
test('Vision: VisualTargetingController aligns, verifies range, and confirms wood inventory delta', async () => {
  const controller = new VisualTargetingController();

  let lookedAt = null;
  let blockBroken = false;
  let currentInventory = [];

  const mockBot = {
    entity: {
      position: { x: 0, y: 64, z: 0 },
      height: 1.62,
      yaw: 0.0,
      pitch: 0.0
    },
    lookAt: async (vec) => {
      lookedAt = vec;
      mockBot.entity.yaw = Math.atan2(-vec.x, vec.z);
    },
    blockAt: () => ({ name: 'oak_log' }),
    dig: async () => {
      blockBroken = true;
      currentInventory.push({ name: 'oak_log', count: 1 });
    },
    inventory: {
      items: () => currentInventory
    }
  };

  const target = {
    id: 'tree-target-1',
    class: 'tree_trunk',
    worldPos: { x: 0, y: 64, z: 3.0 },
    distance: 3.0
  };

  // 1. Verify Range
  const range = controller.verifyRange(mockBot, target);
  assert.strictEqual(range.inRange, true);
  assert.strictEqual(range.distance, 3.0);

  // 2. Execute Harvest
  const result = await controller.executeVisualHarvest(mockBot, target);

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.preCount, 0);
  assert.strictEqual(result.postCount, 1);
  assert.strictEqual(result.delta, 1);
  assert.strictEqual(blockBroken, true);
  assert.ok(lookedAt !== null);
});

// ============================================================================
// Test 6: Asynchronous Fallback Safety
// ============================================================================
test('Vision: MikaVisionEngine gracefully falls back to Mineflayer search when vision returns no targets', async () => {
  const engine = new MikaVisionEngine();

  // Mock bot with oak log nearby in Mineflayer
  let currentInventory = [];
  const mockBot = {
    entity: { position: { x: 10, y: 64, z: 10 }, height: 1.62, yaw: 0, pitch: 0 },
    findBlock: (opt) => ({
      name: 'oak_log',
      position: { x: 12, y: 64, z: 10 }
    }),
    blockAt: () => ({ name: 'oak_log' }),
    lookAt: async () => {},
    dig: async () => {
      currentInventory.push({ name: 'oak_log', count: 1 });
    },
    inventory: {
      items: () => currentInventory
    }
  };

  // Force vision inference to return empty detections to trigger fallback
  engine.runInferenceAsync = async () => ({ detections: [], latency_ms: 15, gpu_vram_mb: 2.0, fallback: true });

  const result = await engine.executeVisualTreeHarvest(mockBot, { fastMode: true });

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.fallbackUsed, true);
  assert.strictEqual(result.target.class, 'tree_trunk');
  assert.strictEqual(result.outcome.delta, 1);
});

// ============================================================================
// Test 7: Separate Accuracy and Task Success Reporting
// ============================================================================
test('Vision: VisualExperienceLogger logs experiences and calculates accuracy vs task metrics separately', () => {
  const tmpDir = path.join(process.cwd(), 'data', 'vision', 'test');
  const logger = new VisualExperienceLogger({ dataDir: tmpDir });

  logger.logExperience({
    actionAttempted: true,
    action: 'harvest_tree_trunk',
    accuracy: {
      stepTruePositives: 2,
      stepFalsePositives: 1,
      stepMissedTargets: 0
    },
    outcome: { success: true, delta: 1, durationMs: 450 },
    latency_ms: 18.5,
    gpu_vram_mb: 3.2
  });

  logger.logExperience({
    actionAttempted: true,
    action: 'harvest_tree_trunk',
    accuracy: {
      stepTruePositives: 1,
      stepFalsePositives: 0,
      stepMissedTargets: 1
    },
    outcome: { success: true, delta: 2, durationMs: 510 },
    latency_ms: 22.0,
    gpu_vram_mb: 3.2
  });

  const report = logger.generateReport();

  // Detection Accuracy Metrics
  assert.strictEqual(report.detection_accuracy.true_positives, 3);
  assert.strictEqual(report.detection_accuracy.false_positives, 1);
  assert.strictEqual(report.detection_accuracy.missed_targets, 1);
  assert.strictEqual(report.detection_accuracy.precision, 0.75); // 3 / (3 + 1)
  assert.strictEqual(report.detection_accuracy.recall, 0.75);    // 3 / (3 + 1)

  // Task Performance Metrics
  assert.strictEqual(report.task_performance.tasks_attempted, 2);
  assert.strictEqual(report.task_performance.tasks_succeeded, 2);
  assert.strictEqual(report.task_performance.task_success_rate, 1.0);
  assert.strictEqual(report.task_performance.total_wood_harvested, 3);

  // Resource Metrics
  assert.ok(report.resource_metrics.avg_inference_latency_ms > 0);
  assert.strictEqual(report.resource_metrics.avg_gpu_vram_mb, 3.2);
});
