import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

import { PersistentMemoryStore } from '../src/learning/memory.js';
import { collectObservation } from '../src/minecraft/observe.js';
import { buildReasoningContext } from '../src/planner/context.js';
import { selectContextualGoal } from '../src/survival/priority.js';
import { defaultShelterManager } from '../src/survival/shelter.js';
import { executeFarmCrop } from '../src/actions/farming.js';
import { executeCollectResource } from '../src/actions/resources.js';

test('PersistentMemoryStore records and retrieves shelter base, food, farm, and lost things', () => {
  const testLocFile = path.join('./data/test', 'test_locations.json');
  const testDeathFile = path.join('./data/test', 'test_deaths.json');
  if (fs.existsSync(testLocFile)) fs.unlinkSync(testLocFile);
  if (fs.existsSync(testDeathFile)) fs.unlinkSync(testDeathFile);

  const memory = new PersistentMemoryStore({
    locationsFilePath: testLocFile,
    deathsFilePath: testDeathFile
  });

  // 1. Record shelter base
  const shelter = memory.recordLocation('shelter', { x: 100.4, y: 65, z: 200.2 }, {
    name: 'Main Base Camp',
    is_safe: true
  });
  assert.strictEqual(shelter.type, 'shelter_base');
  assert.strictEqual(shelter.position.x, 100.4);
  assert.strictEqual(shelter.position.z, 200.2);

  // Both 'shelter' and 'base' aliases should retrieve it
  const retrievedShelter = memory.getLocation('shelter');
  const retrievedBase = memory.getLocation('base');
  assert.ok(retrievedShelter);
  assert.strictEqual(retrievedShelter.name, 'Main Base Camp');
  assert.strictEqual(retrievedBase.id, retrievedShelter.id);

  // 2. Proximity update (updating shelter within 8m)
  const updatedShelter = memory.recordLocation('shelter', { x: 102.0, y: 65, z: 201.0 }, {
    is_safe: true,
    upgraded: true
  });
  assert.strictEqual(updatedShelter.id, shelter.id);
  assert.strictEqual(updatedShelter.position.x, 102);
  assert.strictEqual(updatedShelter.metadata.upgraded, true);
  assert.strictEqual(memory.getLocations('shelter').length, 1);

  // 3. Record food location
  const food = memory.recordLocation('food', { x: 150, y: 64, z: 210 }, {
    name: 'Sweet Berry Patch',
    food_type: 'sweet_berries'
  });
  assert.strictEqual(food.type, 'food');
  const retrievedFood = memory.getLocation('food');
  assert.ok(retrievedFood);
  assert.strictEqual(retrievedFood.metadata.food_type, 'sweet_berries');

  // 4. Record farm location
  const farm = memory.recordLocation('farm', { x: 95, y: 64, z: 190 }, {
    name: 'Wheat Farm',
    crop_type: 'wheat'
  });
  assert.strictEqual(farm.type, 'farm');
  const retrievedFarm = memory.getLocation('farm');
  assert.ok(retrievedFarm);
  assert.strictEqual(retrievedFarm.metadata.crop_type, 'wheat');

  // 5. Nearest location lookup
  const nearest = memory.getNearestLocation('shelter', { x: 90, z: 195 });
  assert.ok(nearest);
  assert.strictEqual(nearest.location.name, 'Main Base Camp');
  assert.ok(nearest.distance < 20);

  // 6. Persistence check across reloads
  const reloaded = new PersistentMemoryStore({
    locationsFilePath: testLocFile,
    deathsFilePath: testDeathFile
  });
  assert.strictEqual(reloaded.locations.length, 3);
  assert.ok(reloaded.getLocation('shelter'));
  assert.ok(reloaded.getLocation('food'));
  assert.ok(reloaded.getLocation('farm'));

  // Clean up
  if (fs.existsSync(testLocFile)) fs.unlinkSync(testLocFile);
  if (fs.existsSync(testDeathFile)) fs.unlinkSync(testDeathFile);
});

test('PersistentMemoryStore records death reason and lost things location', () => {
  const testLocFile = path.join('./data/test', 'test_death_loc.json');
  const testDeathFile = path.join('./data/test', 'test_death_hist.json');
  if (fs.existsSync(testLocFile)) fs.unlinkSync(testLocFile);
  if (fs.existsSync(testDeathFile)) fs.unlinkSync(testDeathFile);

  const memory = new PersistentMemoryStore({
    locationsFilePath: testLocFile,
    deathsFilePath: testDeathFile
  });

  assert.strictEqual(memory.getLastDiedReason(), 'No recorded deaths');

  // Record death event with items dropped
  const death = memory.recordDeath({
    position: { x: -45.5, y: 62, z: 120.3 },
    dimension: 'overworld',
    reason: 'Blown up by Creeper',
    killer: 'creeper',
    lostItems: [
      { name: 'iron_pickaxe', count: 1 },
      { name: 'bread', count: 8 },
      { name: 'oak_log', count: 16 }
    ]
  });

  assert.strictEqual(death.reason, 'Blown up by Creeper');
  assert.strictEqual(death.killer, 'creeper');
  assert.strictEqual(death.lost_items.length, 3);
  assert.strictEqual(memory.getLastDiedReason(), 'Blown up by Creeper');

  // Verify lost things location was automatically created
  const lost = memory.getLostThingsLocation();
  assert.ok(lost);
  assert.strictEqual(lost.type, 'lost_things');
  assert.strictEqual(lost.position.x, -45.5);
  assert.strictEqual(lost.position.z, 120.3);
  assert.strictEqual(lost.metadata.lost_items.length, 3);
  assert.strictEqual(lost.metadata.reason, 'Blown up by Creeper');

  // Test updating official server death message
  memory.updateLastDeathMessage('MIKA_Bot was blown up by Creeper', 'creeper');
  assert.strictEqual(memory.getLastDiedReason(), 'MIKA_Bot was blown up by Creeper');
  assert.strictEqual(memory.getLostThingsLocation().metadata.reason, 'MIKA_Bot was blown up by Creeper');

  // Summary object contains all locations and death reason
  const summary = memory.getKnownLocationsSummary();
  assert.strictEqual(summary.last_died_reason, 'MIKA_Bot was blown up by Creeper');
  assert.ok(summary.lost_things);

  // Clearing lost things once recovered
  memory.clearLostThings();
  assert.strictEqual(memory.getLostThingsLocation(), null);

  // Clean up
  if (fs.existsSync(testLocFile)) fs.unlinkSync(testLocFile);
  if (fs.existsSync(testDeathFile)) fs.unlinkSync(testDeathFile);
});

test('Observation and Reasoning Context expose known locations and last death reason', () => {
  const memory = new PersistentMemoryStore();
  memory.recordLocation('shelter', { x: 50, y: 64, z: 50 }, { name: 'HQ' });
  memory.recordLocation('food', { x: 60, y: 64, z: 55 }, { name: 'Berry Orchard' });
  memory.recordLocation('farm', { x: 40, y: 64, z: 45 }, { name: 'Carrot Field' });
  memory.recordDeath({
    position: { x: 10, y: 64, z: 10 },
    reason: 'Shot by Skeleton',
    killer: 'skeleton',
    lostItems: [{ name: 'bow', count: 1 }]
  });

  const mockBot = {
    entity: { position: { x: 0, y: 64, z: 0 }, yaw: 0, pitch: 0 },
    health: 20,
    food: 20,
    memoryStore: memory,
    collectObservation
  };

  const obs = collectObservation(mockBot);
  assert.ok(obs.known_locations);
  assert.strictEqual(obs.known_locations.shelter_base.name, 'HQ');
  assert.strictEqual(obs.known_locations.food.name, 'Berry Orchard');
  assert.strictEqual(obs.known_locations.farm.name, 'Carrot Field');
  assert.strictEqual(obs.known_locations.last_died_reason, 'Shot by Skeleton');
  assert.strictEqual(obs.last_death.reason, 'Shot by Skeleton');

  const context = buildReasoningContext({ observation: obs, memoryStore: memory });
  assert.ok(context.known_locations);
  assert.strictEqual(context.known_locations.shelter_base.position.x, 50);
  assert.strictEqual(context.last_death.reason, 'Shot by Skeleton');

  // Clean up
  memory.clear();
});

test('Contextual Goal Prioritization leverages remembered shelter base and lost things', () => {
  // 1. At night, unsheltered bot returns to remembered shelter base if nearby
  const nightWithKnownShelter = {
    agent: { position: { x: 10, y: 64, z: 10 }, health: 20, food: 20, isAlive: true },
    environment: { is_night: true, isDay: false, time_of_day: 14000 },
    shelter_safety: { safe: false },
    nearby_threats: [],
    known_locations: {
      shelter_base: { position: { x: 20, y: 64, z: 20 }, name: 'Safe House' }
    }
  };

  const selectedBaseGoal = selectContextualGoal(nightWithKnownShelter);
  assert.strictEqual(selectedBaseGoal.goalId, 'RETURN_TO_SHELTER_BASE');
  assert.strictEqual(selectedBaseGoal.tier, 2);
  assert.ok(selectedBaseGoal.reason.includes('returning to remembered shelter base'));

  // 2. Daytime with active lost things prioritizes recovery of items
  const daytimeWithLostItems = {
    agent: { position: { x: 0, y: 64, z: 0 }, health: 20, food: 20, isAlive: true },
    environment: { is_night: false, isDay: true, time_of_day: 1000 },
    shelter_safety: { safe: true },
    nearby_threats: [],
    known_locations: {
      lost_things: {
        position: { x: 15, y: 64, z: 15 },
        metadata: { reason: 'Slain by Zombie', lost_items: [{ name: 'diamond_sword', count: 1 }] }
      }
    }
  };

  const selectedRecoverGoal = selectContextualGoal(daytimeWithLostItems);
  assert.strictEqual(selectedRecoverGoal.goalId, 'RECOVER_LOST_ITEMS');
  assert.strictEqual(selectedRecoverGoal.tier, 3);
  assert.ok(selectedRecoverGoal.reason.includes('Recovering items lost'));
});

test('Automatic location recording: emergency shelter, farming, and food gathering', async () => {
  const memory = new PersistentMemoryStore();
  memory.clear();

  // Test building emergency shelter auto-registers shelter base
  const mockBotForShelter = {
    entity: { position: { x: 10, y: 64, z: 10 } },
    memoryStore: memory,
    collectObservation: () => ({ inventory: [{ name: 'dirt', count: 12 }] }),
    inventory: { items: () => [{ name: 'dirt', count: 12 }] },
    mockShelterState: { safe: true, hasRoof: true, wallCoverage: 4 }
  };

  const shelterRes = await defaultShelterManager.buildEmergencyShelter(mockBotForShelter);
  assert.strictEqual(shelterRes.status, 'success');
  const baseLoc = memory.getLocation('shelter');
  assert.ok(baseLoc);
  assert.strictEqual(baseLoc.name, 'Emergency Shelter Base');
  assert.strictEqual(baseLoc.position.x, 10);
  assert.strictEqual(baseLoc.position.z, 10);

  // Test farming action auto-registers farm location
  const mockBotForFarm = {
    entity: { position: { x: 30, y: 64, z: 30 } },
    memoryStore: memory,
    findBlock: () => ({
      name: 'wheat',
      metadata: 7,
      position: { x: 32, y: 64, z: 32, offset: (dx, dy, dz) => ({ x: 32 + dx, y: 64 + dy, z: 32 + dz }) }
    }),
    dig: async () => {},
    blockAt: () => ({ name: 'farmland' }),
    inventory: { items: () => [{ name: 'wheat_seeds', count: 2 }] },
    equip: async () => {},
    placeBlock: async () => {}
  };

  const farmRes = await executeFarmCrop(mockBotForFarm);
  assert.strictEqual(farmRes.status, 'success');
  const farmLoc = memory.getLocation('farm');
  assert.ok(farmLoc);
  assert.strictEqual(farmLoc.position.x, 32);
  assert.strictEqual(farmLoc.position.z, 32);
  assert.strictEqual(farmLoc.metadata.crop_type, 'wheat');

  // Test food gathering auto-registers food location
  const mockBotForFood = {
    entity: {
      position: {
        x: 50,
        y: 64,
        z: 50,
        distanceTo: (p) => Math.hypot(50 - p.x, 50 - p.z)
      }
    },
    memoryStore: memory,
    findBlock: () => ({
      name: 'sweet_berries',
      position: { x: 52, y: 64, z: 52 },
      hardness: 0.2
    }),
    canDigBlock: () => true,
    dig: async () => {},
    lookAt: async () => {}
  };

  const foodRes = await executeCollectResource(mockBotForFood, { resource: 'sweet_berries', count: 1 });
  assert.strictEqual(foodRes.status, 'success');
  const foodLoc = memory.getLocation('food');
  assert.ok(foodLoc);
  assert.strictEqual(foodLoc.position.x, 52);
  assert.strictEqual(foodLoc.position.z, 52);
  assert.strictEqual(foodLoc.metadata.food_type, 'sweet_berries');

  // Clean up
  memory.clear();
});

test('SwarmBlackboard tracks farms, food sources, and lost things', async () => {
  const { SwarmBlackboard } = await import('../src/swarm/blackboard.js');
  const bb = new SwarmBlackboard({ autoHydrate: false });

  // 1. Farms
  bb.registerFarm({ x: 10, y: 64, z: 20, crop: 'carrots', registeredBy: 'MIKA_Farmer' });
  assert.strictEqual(bb.getAllFarms().length, 1);
  const nearestFarm = bb.getNearestFarm({ x: 12, z: 20 });
  assert.ok(nearestFarm);
  assert.strictEqual(nearestFarm.crop, 'carrots');
  assert.strictEqual(nearestFarm.distance, 2);

  // 2. Food Sources
  bb.registerFoodSource({ x: 30, y: 64, z: 40, type: 'sweet_berries', discoveredBy: 'MIKA_Explorer' });
  assert.strictEqual(bb.getAllFoodSources().length, 1);
  const nearestFood = bb.getNearestFoodSource({ x: 31, z: 40 });
  assert.ok(nearestFood);
  assert.strictEqual(nearestFood.type, 'sweet_berries');

  // 3. Lost Things
  bb.registerLostThings({
    x: 50,
    y: 64,
    z: 50,
    botName: 'MIKA_Gatherer',
    reason: 'Blown up by Creeper',
    lostItems: [{ name: 'diamond_pickaxe', count: 1 }]
  });
  const lost = bb.getLostThings();
  assert.ok(lost);
  assert.strictEqual(lost.botName, 'MIKA_Gatherer');
  assert.strictEqual(lost.lostItems.length, 1);

  bb.clearLostThings();
  assert.strictEqual(bb.getLostThings(), null);
});

