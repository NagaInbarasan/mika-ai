import test from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import fs from 'fs';
import path from 'path';
import {
  TwoPlayerShelterSkill,
  defaultTwoPlayerShelterSkill,
  SHELTER_STAGES
} from '../src/skills/two-player-shelter.js';
import { SkillManager } from '../src/skills/skill-manager.js';
import { normalizeGoalId, GOAL_DEFINITIONS } from '../src/learning/goals.js';

// Mock bot factory for realistic testing
function createMockBot(options = {}) {
  const blocks = new Map();
  const inventory = options.inventory || [
    { name: 'dirt', count: 128 },
    { name: 'oak_planks', count: 64 },
    { name: 'torch', count: 8 },
    { name: 'oak_door', count: 1 },
    { name: 'crafting_table', count: 1 },
    { name: 'furnace', count: 1 },
    { name: 'chest', count: 2 },
    { name: 'white_bed', count: 2 }
  ];

  const pos = options.position || new Vec3(100, 64, 100);

  // Initialize ground blocks relative to bot position
  const cx = Math.floor(pos.x);
  const cy = Math.floor(pos.y);
  const cz = Math.floor(pos.z);
  for (let x = cx - 25; x <= cx + 25; x++) {
    for (let z = cz - 25; z <= cz + 25; z++) {
      blocks.set(`${x},${cy - 1},${z}`, { name: 'grass_block', boundingBox: 'block' });
      blocks.set(`${x},${cy},${z}`, { name: 'air', boundingBox: 'empty' });
      blocks.set(`${x},${cy + 1},${z}`, { name: 'air', boundingBox: 'empty' });
      blocks.set(`${x},${cy + 2},${z}`, { name: 'air', boundingBox: 'empty' });
      blocks.set(`${x},${cy + 3},${z}`, { name: 'air', boundingBox: 'empty' });
    }
  }

  return {
    entity: {
      position: pos,
      yaw: 0,
      pitch: 0
    },
    time: { timeOfDay: options.timeOfDay || 6000 },
    health: options.health || 20,
    food: options.food || 20,
    inventory: {
      items: () => inventory
    },
    entities: options.entities || {},
    blockAt: (target) => {
      const x = Math.floor(target.x);
      const y = Math.floor(target.y);
      const z = Math.floor(target.z);
      const key = `${x},${y},${z}`;
      const found = blocks.get(key) || { name: 'air', boundingBox: 'empty' };
      return {
        ...found,
        position: new Vec3(x, y, z)
      };
    },
    placeBlock: async (refBlock, face) => {
      const placedPos = refBlock.position ? refBlock.position.plus(face) : new Vec3(0, 0, 0);
      const key = `${Math.floor(placedPos.x)},${Math.floor(placedPos.y)},${Math.floor(placedPos.z)}`;
      blocks.set(key, { name: 'dirt', boundingBox: 'block' });
      return true;
    },
    dig: async (targetBlock) => {
      return true;
    },
    lookAt: async () => {},
    equip: async () => {},
    activateBlock: async () => true,
    collectObservation: (b) => ({
      agent: { position: b.entity.position, health: b.health, food: b.food },
      nearby_resources: [{ name: 'oak_log', distance: 10 }],
      nearby_threats: options.threats || []
    }),
    _blocksMap: blocks
  };
}

test('Goal definition: BUILD_TWO_PLAYER_SHELTER registered and normalized', () => {
  assert.ok(GOAL_DEFINITIONS.BUILD_TWO_PLAYER_SHELTER, 'BUILD_TWO_PLAYER_SHELTER must exist');
  assert.strictEqual(normalizeGoalId('two_player_shelter'), 'BUILD_TWO_PLAYER_SHELTER');
  assert.strictEqual(normalizeGoalId('2p_shelter'), 'BUILD_TWO_PLAYER_SHELTER');
  assert.strictEqual(normalizeGoalId('base'), 'BUILD_TWO_PLAYER_SHELTER');
  assert.strictEqual(normalizeGoalId('duo_shelter'), 'BUILD_TWO_PLAYER_SHELTER');
});

test('Phase 1: inspectAndPlan detects flat terrain and selects optimal candidate', () => {
  const bot = createMockBot();
  const skill = new TwoPlayerShelterSkill();
  const inspection = skill.inspectAndPlan(bot);

  assert.strictEqual(inspection.suitable, true);
  assert.ok(inspection.chosenSite, 'Chosen site must be selected');
  assert.ok(inspection.score >= 0.5, 'Selected site score must be high');
  assert.ok(inspection.reason.includes('Selected optimal shelter site'));
  assert.ok(inspection.candidates.length > 0, 'Candidate sites must be evaluated');
});

test('Phase 1: inspectAndPlan rejects sites with fatal hazards (lava/cliff)', () => {
  const bot = createMockBot();
  // Plant lava in ground
  bot._blocksMap.set('100,63,100', { name: 'lava', boundingBox: 'empty' });

  const skill = new TwoPlayerShelterSkill();
  const inspection = skill.inspectAndPlan(bot);
  assert.ok(inspection.chosenSite, 'Should fall back to clean offset candidate');
  assert.notStrictEqual(`${inspection.chosenSite.x},${inspection.chosenSite.z}`, '100,100', 'Must not choose lava center');
});

test('Phase 2: generateTwoPlayerBlueprint produces 9x9 exterior and 7x7 interior layout', () => {
  const skill = new TwoPlayerShelterSkill({ width: 9, length: 9, height: 3 });
  const origin = new Vec3(100, 64, 100);
  const bp = skill.generateTwoPlayerBlueprint(origin);

  assert.strictEqual(bp.dimensions.width, 9);
  assert.strictEqual(bp.dimensions.length, 9);
  assert.strictEqual(bp.dimensions.interiorArea, 49, 'Interior area should be 7x7 = 49m²');
  assert.strictEqual(bp.floorBlocks.length, 81, '9x9 floor = 81 blocks');
  assert.strictEqual(bp.roofBlocks.length, 81, '9x9 roof = 81 blocks');
  // Wall perimeter: 9*4 - 4 = 32 per level. 3 levels = 96 minus 2 for door opening = 94
  assert.strictEqual(bp.wallBlocks.length, 94);
  assert.strictEqual(bp.lightPositions.length, 4, 'Should have 4 lighting positions');
  assert.ok(bp.furniture.craftingTable);
  assert.ok(bp.furniture.furnace);
  assert.ok(bp.furniture.chest1);
  assert.ok(bp.furniture.chest2);
  assert.ok(bp.furniture.bed1);
  assert.ok(bp.furniture.bed2);
  assert.ok(bp.walkingCorridor.length >= 8, 'Must include clear walking corridor');
});

test('Phase 3: calculateMaterialManifest accurately calculates quantities and deficits', () => {
  const skill = new TwoPlayerShelterSkill({ width: 9, length: 9, height: 3 });
  const bp = skill.generateTwoPlayerBlueprint(new Vec3(100, 64, 100));

  // Empty inventory
  const emptyManifest = skill.calculateMaterialManifest(bp, []);
  assert.strictEqual(emptyManifest.isBlocked, true);
  assert.ok(emptyManifest.structuralDeficit > 200, 'Should have structural deficit');
  assert.ok(emptyManifest.missingMaterials.some(m => m.material === 'solid_building_blocks'));

  // Well-stocked inventory
  const stockedInventory = [
    { name: 'dirt', count: 300 },
    { name: 'oak_planks', count: 64 },
    { name: 'torch', count: 16 },
    { name: 'oak_door', count: 1 },
    { name: 'crafting_table', count: 1 },
    { name: 'furnace', count: 1 },
    { name: 'chest', count: 2 },
    { name: 'white_bed', count: 2 }
  ];
  const readyManifest = skill.calculateMaterialManifest(bp, stockedInventory);
  assert.strictEqual(readyManifest.isBlocked, false);
  assert.strictEqual(readyManifest.deficits.structural, 0);
  assert.strictEqual(readyManifest.deficits.torches, 0);
  assert.strictEqual(readyManifest.deficits.door, 0);
});

test('Phase 4: constructPhased executes 13 stages and completes verified construction', async () => {
  const bot = createMockBot({
    inventory: [
      { name: 'dirt', count: 350 },
      { name: 'torch', count: 8 },
      { name: 'oak_door', count: 1 },
      { name: 'crafting_table', count: 1 },
      { name: 'furnace', count: 1 },
      { name: 'chest', count: 2 },
      { name: 'white_bed', count: 2 }
    ]
  });

  const skill = new TwoPlayerShelterSkill({ width: 7, length: 7, height: 3 });
  const bp = skill.generateTwoPlayerBlueprint(new Vec3(100, 64, 100));
  const result = await skill.constructPhased(bot, bp);

  assert.strictEqual(result.status, 'success');
  assert.strictEqual(result.isComplete, true);
  assert.ok(skill.metrics.stagesCompleted.includes(SHELTER_STAGES.FOOTPRINT));
  assert.ok(skill.metrics.stagesCompleted.includes(SHELTER_STAGES.FLOOR));
  assert.ok(skill.metrics.stagesCompleted.includes(SHELTER_STAGES.WALLS));
  assert.ok(skill.metrics.stagesCompleted.includes(SHELTER_STAGES.ROOF));
  assert.ok(skill.metrics.stagesCompleted.includes(SHELTER_STAGES.DOOR));
  assert.ok(skill.metrics.stagesCompleted.includes(SHELTER_STAGES.LIGHTING));
  assert.ok(skill.metrics.stagesCompleted.includes(SHELTER_STAGES.CRAFTING_TABLE));
  assert.ok(skill.metrics.stagesCompleted.includes(SHELTER_STAGES.FURNACE));
  assert.ok(skill.metrics.stagesCompleted.includes(SHELTER_STAGES.CHESTS));
  assert.ok(skill.metrics.stagesCompleted.includes(SHELTER_STAGES.BEDS));
});

test('Phase 5: validateTwoPlayerCapacity verifies movement clearance and dual beds', () => {
  const skill = new TwoPlayerShelterSkill({ width: 9, length: 9, height: 3 });
  const bp = skill.generateTwoPlayerBlueprint(new Vec3(100, 64, 100));
  const bot = createMockBot();

  const capacity = skill.validateTwoPlayerCapacity(bot, bp);
  assert.strictEqual(capacity.valid, true);
  assert.strictEqual(capacity.interiorArea, 49);
  assert.ok(capacity.clearStandingSpots >= 4);
  assert.ok(capacity.reason.includes('Two-player capacity verified'));
});

test('Phase 6: handleThreatInterruption preserves checkpoint and secures bot', async () => {
  const bot = createMockBot();
  const skill = new TwoPlayerShelterSkill();
  const bp = skill.generateTwoPlayerBlueprint(new Vec3(100, 64, 100));

  skill.currentCheckpoint = { stage: SHELTER_STAGES.WALLS, stepIndex: 15 };
  skill.metrics.stagesCompleted.push(SHELTER_STAGES.WALLS);

  const interruptResult = await skill.handleThreatInterruption(bot, { name: 'zombie', distance: 4.5 }, bp);
  assert.strictEqual(interruptResult.interrupted, true);
  assert.strictEqual(interruptResult.savedCheckpoint.stage, SHELTER_STAGES.WALLS);
  assert.strictEqual(interruptResult.savedCheckpoint.stepIndex, 15);
  assert.strictEqual(skill.metrics.threatInterruptions, 1);
  assert.strictEqual(skill.metrics.recoverySuccesses, 1);
});

test('Phase 7: verifyShelterSafety checks floor, walls, roof, door and lighting', () => {
  const skill = new TwoPlayerShelterSkill();
  const bp = skill.generateTwoPlayerBlueprint(new Vec3(100, 64, 100));
  const bot = createMockBot();

  // Incomplete check: should fail when walls/roof are not yet placed
  const incomplete = skill.verifyShelterSafety(bot, bp);
  assert.strictEqual(incomplete.safe, false);
  assert.ok(incomplete.reason.includes('Incomplete'));

  // Populate shelter blocks into world map
  for (const p of bp.floorBlocks) bot._blocksMap.set(`${p.x},${p.y},${p.z}`, { name: 'dirt', boundingBox: 'block' });
  for (const p of bp.wallBlocks) bot._blocksMap.set(`${p.x},${p.y},${p.z}`, { name: 'oak_planks', boundingBox: 'block' });
  for (const p of bp.roofBlocks) bot._blocksMap.set(`${p.x},${p.y},${p.z}`, { name: 'oak_planks', boundingBox: 'block' });
  bot._blocksMap.set(`${bp.doorLocation.x},${bp.doorLocation.y},${bp.doorLocation.z}`, { name: 'oak_door', boundingBox: 'block' });

  // Complete check: passes all safety, roof, wall and capacity gates
  const complete = skill.verifyShelterSafety(bot, bp);
  assert.strictEqual(complete.safe, true);
  assert.ok(complete.score >= 0.9);
  assert.ok(complete.twoPlayerCapacity.valid);
});

test('Phase 8 & 9: saveAsLearnedSkill persists to disk and adaptSkillToWorld reuses skill', async () => {
  const testSkillsDir = path.join(process.cwd(), 'data', 'test', 'skills');
  const skillManager = new SkillManager({ skillsDir: testSkillsDir });

  const skill = new TwoPlayerShelterSkill({ skillManager, width: 7, length: 7 });
  const saved = skill.saveAsLearnedSkill({ status: 'success', isComplete: true });

  assert.strictEqual(saved.skill_id, 'build_secure_two_player_shelter');
  assert.strictEqual(saved.version, 'v1.3.0');
  assert.ok(fs.existsSync(path.join(testSkillsDir, 'build_secure_two_player_shelter.json')));

  // Test reuse in new world
  const newBot = createMockBot({
    position: new Vec3(200, 64, 200),
    inventory: [
      { name: 'dirt', count: 200 },
      { name: 'torch', count: 4 },
      { name: 'oak_door', count: 1 }
    ]
  });

  const adaptedResult = await skill.adaptSkillToWorld(newBot);
  assert.strictEqual(adaptedResult.isComplete, true);
});
