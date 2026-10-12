import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';

import { TaskManager, Task, TASK_STATE, TASK_CATEGORY } from '../src/tasks/task-manager.js';
import { ThreatManager, THREAT_TIERS } from '../src/survival/threat-manager.js';
import { BaseShelterBuilder, SHELTER_PHASE } from '../src/survival/base-shelter.js';
import { CraftingKnowledgeSystem } from '../src/crafting/knowledge.js';
import { FoodManager, COOKABLE_FOODS } from '../src/survival/food-manager.js';
import { BedManager } from '../src/survival/bed-manager.js';
import { StorageOrganizer, STORAGE_CATEGORIES } from '../src/storage/organization.js';
import { AutonomousSurvivalController } from '../src/survival/autonomous.js';
import { selectContextualGoal } from '../src/survival/priority.js';

describe('MIKA V1.3 — Survival, Shelter, Food & Storage Master Suite', () => {

  // Scenario 1: Threat Interruption and Resumption from Verified Checkpoint
  it('Scenario 1: Threat interruption preserves checkpoint and resumes without progress loss', () => {
    const taskManager = new TaskManager();

    // 1. Register building shelter task
    const buildTask = taskManager.register({
      id: 'BUILD_BASE_SHELTER',
      objective: 'Construct survival base shelter',
      category: TASK_CATEGORY.SHELTER,
      priorityTier: 3,
      progress: { current: 14, total: 28, unit: 'blocks', checkpoint: { phase: 'WALLS', stepIndex: 14 } }
    });

    taskManager.startTask('BUILD_BASE_SHELTER');
    assert.equal(buildTask.state, TASK_STATE.IN_PROGRESS);
    assert.equal(taskManager.getActiveTask().id, 'BUILD_BASE_SHELTER');

    // 2. Zombie appears! Emergency interruption triggered
    taskManager.interruptCurrentTask('Zombie threat detected within 4m', { phase: 'WALLS', stepIndex: 14 });
    assert.equal(buildTask.state, TASK_STATE.INTERRUPTED);
    assert.equal(taskManager.getActiveTask(), null);
    assert.equal(taskManager.hasInterruptedTasks(), true);
    assert.equal(buildTask.interruptedState.checkpoint.stepIndex, 14);

    // 3. Priority selector resumes task once threat clears
    const daytimeObs = {
      agent: { health: 20, food: 20 },
      nearby_threats: [],
      environment: { is_night: false, time_of_day: 6000 }
    };
    const priority = selectContextualGoal(daytimeObs, null, null, taskManager);
    assert.equal(priority.goalId, 'BUILD_BASE_SHELTER');
    assert.equal(priority.tier, 3);
    assert.equal(priority.isResumed, true);

    // 4. Resume task
    const resumed = taskManager.resumeInterruptedTask();
    assert.equal(resumed.id, 'BUILD_BASE_SHELTER');
    assert.equal(resumed.state, TASK_STATE.IN_PROGRESS);
    assert.deepEqual(resumed.progress.checkpoint, { phase: 'WALLS', stepIndex: 14 });
    assert.equal(taskManager.getActiveTask().id, 'BUILD_BASE_SHELTER');
  });

  // Scenario 2: Anti-Stagnation Thrashing Protection
  it('Scenario 2: Anti-stagnation detects rapid task switching and activates backoff cooldown', () => {
    const taskManager = new TaskManager({ thrashWindowMs: 5000, maxRapidSwitches: 4 });

    taskManager.register({ id: 'TASK_A', priorityTier: 3 });
    taskManager.register({ id: 'TASK_B', priorityTier: 3 });

    // Rapid thrashing between TASK_A and TASK_B
    taskManager.startTask('TASK_A');
    taskManager.startTask('TASK_B');
    taskManager.startTask('TASK_A');
    taskManager.startTask('TASK_B');

    assert.equal(taskManager.isStagnationActive(), true);
  });

  // Scenario 3: Shelter Site Assessment (Phase A)
  it('Scenario 3: Assesses shelter site candidates, rejects hazardous lava, and records chosen location', () => {
    const builder = new BaseShelterBuilder({ width: 5, length: 5 });

    // Mock bot with ground blocks
    const recordedLocations = [];
    const mockBot = {
      entity: { position: new Vec3(100, 64, 100) },
      memoryStore: {
        recordLocation: (type, pos, meta) => {
          recordedLocations.push({ type, pos, meta });
        }
      },
      blockAt: (pos) => {
        // Center has flat stone ground; offset candidate (+3, 0) has lava
        if (pos.x === 103 && pos.z === 100) {
          return { name: 'lava', boundingBox: 'empty' };
        }
        return { name: 'stone', boundingBox: 'block' };
      },
      collectObservation: () => ({
        nearby_resources: [{ name: 'oak_log', distance: 12 }],
        nearby_threats: []
      })
    };

    const assessment = builder.assessBaseLocation(mockBot);
    assert.equal(assessment.suitable, true);
    assert.ok(assessment.bestSite);
    assert.ok(assessment.score > 0.6);
    assert.equal(recordedLocations.length, 1);
    assert.equal(recordedLocations[0].type, 'shelter');
  });

  // Scenario 4: Phased Shelter Construction & Verification (Phase B & C)
  it('Scenario 4: Generates blueprint and constructs shelter in planned sequence with physical verification', async () => {
    const builder = new BaseShelterBuilder({ width: 5, length: 5, height: 3 });
    const origin = new Vec3(10, 64, 10);
    const blueprint = builder.generateShelterBlueprint(origin);

    // Verify blueprint dimensions and bill of materials
    assert.equal(blueprint.floorBlocks.length, 25);
    assert.ok(blueprint.wallBlocks.length > 20);
    assert.equal(blueprint.roofBlocks.length, 25);
    assert.ok(blueprint.billOfMaterials.totalSolidBlocks > 70);
    assert.equal(blueprint.billOfMaterials.doorNeeded, 1);
    assert.equal(blueprint.billOfMaterials.torchesNeeded, 2);

    // Mock bot placing blocks
    const placed = [];
    const mockBot = {
      entity: { position: origin },
      inventory: {
        items: () => [{ name: 'oak_planks', count: 64 }, { name: 'torch', count: 4 }, { name: 'oak_door', count: 1 }]
      },
      equip: async () => {},
      lookAt: async () => {},
      blockAt: (pos) => {
        if (pos.y <= 62) {
          return { name: 'stone', boundingBox: 'block', position: pos, x: pos.x, y: pos.y, z: pos.z };
        }
        const isPlaced = placed.some(p => p.x === pos.x && p.y === pos.y && p.z === pos.z);
        return isPlaced
          ? { name: 'oak_planks', boundingBox: 'block', position: pos, x: pos.x, y: pos.y, z: pos.z }
          : { name: 'air', boundingBox: 'empty', position: pos, x: pos.x, y: pos.y, z: pos.z };
      },
      placeBlock: async (ref, face) => {
        placed.push(new Vec3(ref.x + face.x, ref.y + face.y, ref.z + face.z));
      }
    };

    const checkpoints = [];
    const result = await builder.buildShelterPhased(mockBot, blueprint, null, (chk) => checkpoints.push(chk));

    assert.equal(result.isComplete, true);
    assert.ok(checkpoints.length > 0);
    assert.equal(result.verification.isComplete, true);
  });

  // Scenario 5: Crafting Knowledge & Recipe Resolution with Tool Tier Upgrade
  it('Scenario 5: Selects stone tool tier over wood when cobblestone available and resolves missing ingredients', () => {
    const crafting = new CraftingKnowledgeSystem();

    // 1. Tool tier preference
    const woodenInv = { oak_planks: 10, stick: 4 };
    const stoneInv = { cobblestone: 5, oak_planks: 4, stick: 2 };
    assert.equal(crafting.selectBestToolTier('pickaxe', woodenInv), 'wooden_pickaxe');
    assert.equal(crafting.selectBestToolTier('pickaxe', stoneInv), 'stone_pickaxe');
    assert.equal(crafting.selectBestToolTier('sword', stoneInv), 'stone_sword');

    // 2. Dependency resolution: crafting stone pickaxe from logs and cobblestone
    const plan = crafting.resolveCraftingPlan('stone_pickaxe', 1, { cobblestone: 3, oak_log: 2 });
    assert.equal(plan.canCraftImmediately, true);
    assert.ok(plan.steps.some(s => s.item === 'planks'));
    assert.ok(plan.steps.some(s => s.item === 'stick'));
    assert.ok(plan.steps.some(s => s.item === 'stone_pickaxe' && s.requiresTable === true));
  });

  // Scenario 6: Food Reserves and Furnace Cooking
  it('Scenario 6: Assesses 3-tier food reserves and cooks raw food in furnace with delta verification', async () => {
    const foodMgr = new FoodManager({ targetCarriedReserve: 8, minEmergencyReserve: 4 });

    // 1. Food reserve assessment
    const obsStarving = {
      inventory: [{ name: 'raw_beef', count: 2 }]
    };
    const assessment = foodMgr.assessFoodReserves(obsStarving);
    assert.equal(assessment.carriedCount, 2);
    assert.equal(assessment.needsEmergencyFood, true);
    assert.equal(assessment.hasRawFoodToCook, true);

    // 2. Cook in furnace
    const mockBot = {
      inventory: {
        items: () => [{ name: 'raw_beef', count: 2 }, { name: 'coal', count: 5 }]
      }
    };

    const cookResult = await foodMgr.cookFoodInFurnace(mockBot, 'raw_beef', 1);
    assert.equal(cookResult.status, 'success');
    assert.equal(cookResult.cookedItem, 'cooked_beef');
    assert.equal(cookResult.delta, 1);
    assert.equal(cookResult.verified, true);
  });

  // Scenario 7: Bed and Sheep Search with Graceful BLOCKED Dependency Handling
  it('Scenario 7: Gracefully marks CRAFT_AND_PLACE_BED as BLOCKED when no sheep are within 32m', () => {
    const bedMgr = new BedManager({ maxSearchRadius: 32 });
    const taskManager = new TaskManager();

    taskManager.register({
      id: 'CRAFT_AND_PLACE_BED',
      objective: 'Obtain wool and craft bed',
      priorityTier: 5
    });

    // Mock bot with no sheep entities
    const mockBotNoSheep = {
      entity: { position: new Vec3(0, 64, 0) },
      entities: {
        '1': { name: 'cow', position: new Vec3(5, 64, 5) }
      },
      inventory: { items: () => [] }
    };

    const evalResult = bedMgr.evaluateBedProgression(mockBotNoSheep, taskManager, 'CRAFT_AND_PLACE_BED');
    assert.equal(evalResult.blocked, true);
    assert.equal(evalResult.status, 'BLOCKED');

    const task = taskManager.getTask('CRAFT_AND_PLACE_BED');
    assert.equal(task.state, TASK_STATE.BLOCKED);
    assert.equal(task.failureReason, 'no_sheep_nearby');
  });

  // Scenario 8: Chest Storage Organization and Personal Survival Reserves
  it('Scenario 8: Categorizes items into 7 categories and retains minimum personal reserves before deposit', async () => {
    const organizer = new StorageOrganizer();

    // 1. Categorization check across 7 categories
    assert.equal(organizer.categorizeItem('oak_planks'), STORAGE_CATEGORIES.BUILDING);
    assert.equal(organizer.categorizeItem('cooked_beef'), STORAGE_CATEGORIES.FOOD);
    assert.equal(organizer.categorizeItem('iron_pickaxe'), STORAGE_CATEGORIES.TOOLS);
    assert.equal(organizer.categorizeItem('diamond_sword'), STORAGE_CATEGORIES.WEAPONS_ARMOR);
    assert.equal(organizer.categorizeItem('iron_ingot'), STORAGE_CATEGORIES.RESOURCES);
    assert.equal(organizer.categorizeItem('diamond'), STORAGE_CATEGORIES.VALUABLES);
    assert.equal(organizer.categorizeItem('name_tag'), STORAGE_CATEGORIES.MISC);

    // 2. Personal reserve retention check (MIKA must never deposit its last sword, pickaxe, or food ration!)
    const inventory = [
      { name: 'iron_sword', count: 2 },
      { name: 'stone_pickaxe', count: 2 },
      { name: 'cooked_beef', count: 12 },
      { name: 'oak_planks', count: 32 },
      { name: 'diamond', count: 5 }
    ];

    const surplus = organizer.calculateDepositableSurplus(inventory);

    // Kept: 1 sword, 1 pickaxe, 8 food, 16 planks. Surplus must be: 1 sword, 1 pickaxe, 4 food, 16 planks, 5 diamonds
    const surplusSword = surplus.find(s => s.item === 'iron_sword');
    const surplusPickaxe = surplus.find(s => s.item === 'stone_pickaxe');
    const surplusFood = surplus.find(s => s.item === 'cooked_beef');
    const surplusPlanks = surplus.find(s => s.item === 'oak_planks');
    const surplusDiamonds = surplus.find(s => s.item === 'diamond');

    assert.equal(surplusSword.count, 1);
    assert.equal(surplusPickaxe.count, 1);
    assert.equal(surplusFood.count, 4);
    assert.equal(surplusPlanks.count, 16);
    assert.equal(surplusDiamonds.count, 5);

    // 3. Deposit into chest container
    const mockContainer = { occupiedSlots: 0, deposit: async () => {} };
    const depositResult = await organizer.depositSurplusIntoChest(null, mockContainer, surplus);
    assert.equal(depositResult.status, 'success');
    assert.equal(depositResult.depositedCount, 5);
    assert.equal(depositResult.isChestFull, false);
  });

  // Scenario 9: Task Manager 8-State Transitions and Validation
  it('Scenario 9: Validates all 8 lifecycle states and rejects invalid transitions', () => {
    const task = new Task({ id: 'TEST_TASK' });
    assert.equal(task.state, TASK_STATE.PLANNED);

    // Valid path: PLANNED -> READY -> IN_PROGRESS -> VERIFYING -> COMPLETED
    task.transitionTo(TASK_STATE.READY);
    assert.equal(task.state, TASK_STATE.READY);

    task.transitionTo(TASK_STATE.IN_PROGRESS);
    assert.equal(task.state, TASK_STATE.IN_PROGRESS);

    // Interruption path
    task.transitionTo(TASK_STATE.INTERRUPTED, { reason: 'Danger' });
    assert.equal(task.state, TASK_STATE.INTERRUPTED);

    task.transitionTo(TASK_STATE.IN_PROGRESS, { reason: 'Safe' });
    assert.equal(task.state, TASK_STATE.IN_PROGRESS);

    // Verifying path
    task.transitionTo(TASK_STATE.VERIFYING);
    assert.equal(task.state, TASK_STATE.VERIFYING);

    task.transitionTo(TASK_STATE.COMPLETED, { reason: 'World verified' });
    assert.equal(task.state, TASK_STATE.COMPLETED);

    // Invalid transition: COMPLETED -> IN_PROGRESS directly should throw
    assert.throws(() => {
      task.transitionTo(TASK_STATE.IN_PROGRESS);
    }, /Invalid state transition/);
  });

  // Scenario 10: Empirical World Verification Rule
  it('Scenario 10: Enforces that tasks are not completed until verified by physical world state', () => {
    const taskManager = new TaskManager();
    const task = taskManager.register({
      id: 'MINE_STONE',
      maxRetries: 2
    });

    taskManager.startTask('MINE_STONE');
    assert.equal(task.state, TASK_STATE.IN_PROGRESS);

    // 1. Verification fails (e.g. inventory delta did not increase)
    const resFail = taskManager.verifyAndComplete('MINE_STONE', () => ({
      verified: false,
      reason: 'No cobblestone added to inventory'
    }));

    assert.equal(resFail.success, false);
    assert.equal(task.state, TASK_STATE.IN_PROGRESS); // retrying
    assert.equal(task.retryCount, 1);

    // 2. Second verification succeeds
    const resSuccess = taskManager.verifyAndComplete('MINE_STONE', () => ({
      verified: true,
      reason: 'Cobblestone count +3 verified'
    }));

    assert.equal(resSuccess.success, true);
    assert.equal(task.state, TASK_STATE.COMPLETED);
    assert.equal(taskManager.getActiveTask(), null);
  });
});
