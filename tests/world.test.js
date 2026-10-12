import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  SimWorld,
  WorldConfig,
  SeededRandom,
  ACTIONS,
  RESOURCES,
  RECIPES
} from '../src/evolution/world.js';

describe('SeededRandom', () => {
  test('generates deterministic sequences', () => {
    const rng1 = new SeededRandom(42);
    const rng2 = new SeededRandom(42);

    for (let i = 0; i < 20; i++) {
      assert.equal(rng1.next(), rng2.next());
    }
  });

  test('generates ints within specified bounds', () => {
    const rng = new SeededRandom(999);
    for (let i = 0; i < 50; i++) {
      const val = rng.int(2, 6);
      assert.ok(val >= 2 && val <= 6);
    }
  });
});

describe('SimWorld Engine', () => {
  test('initializes with default config and valid agent state', () => {
    const world = new SimWorld({}, 12345);
    const obs = world.getObservation();

    assert.equal(obs.agent.alive, true);
    assert.equal(obs.agent.health, 20);
    assert.equal(obs.agent.food, 20);
    assert.equal(obs.isNight, false);
    assert.equal(obs.tick, 0);
  });

  test('movement works correctly and stays within bounds', () => {
    const world = new SimWorld({ gridSize: 10 }, 12345);
    const initialPos = { ...world.agent.position };

    world.tick(ACTIONS.MOVE_NORTH);
    assert.equal(world.agent.position.y, Math.max(0, initialPos.y - 1));

    world.tick(ACTIONS.MOVE_SOUTH);
    assert.equal(world.agent.position.y, initialPos.y);
  });

  test('hunger drains each tick and causes starvation if empty', () => {
    const world = new SimWorld({ hungerRate: 10, maxFood: 20 }, 12345);
    world.tick(ACTIONS.IDLE);
    assert.equal(world.agent.food, 10);
    assert.equal(world.agent.alive, true);

    world.tick(ACTIONS.IDLE);
    assert.equal(world.agent.food, 0);
    assert.equal(world.agent.alive, false);
    assert.equal(world.agent.deathCause, 'starvation');
  });

  test('gathering and crafting pipeline works', () => {
    const world = new SimWorld({}, 12345);
    // Give resources directly to test crafting
    world.modifyInventory('WOOD', 3);
    assert.equal(world.getInventoryCount('WOOD'), 3);

    world.tick(ACTIONS.CRAFT, 'wooden_pickaxe');
    assert.equal(world.agent.tools.has('wooden_pickaxe'), true);
    assert.equal(world.getInventoryCount('WOOD'), 0);
    assert.equal(world.agent.totalCrafted, 1);
  });

  test('shelter kit can be crafted and placed', () => {
    const world = new SimWorld({}, 12345);
    world.modifyInventory('WOOD', 5);
    world.modifyInventory('STONE', 3);

    world.tick(ACTIONS.CRAFT, 'shelter_kit');
    assert.equal(world.getInventoryCount('shelter_kit'), 1);

    const pos = { ...world.agent.position };
    world.tick(ACTIONS.BUILD_SHELTER);
    assert.equal(world.getInventoryCount('shelter_kit'), 0);
    assert.equal(world.agent.hasShelter, true);
    assert.deepEqual(world.agent.shelterPos, pos);
    assert.equal(world.getCell(pos.x, pos.y).shelter, true);
  });

  test('eating raw and cooked food restores hunger', () => {
    const world = new SimWorld({}, 12345);
    world.agent.food = 10;
    world.modifyInventory('FOOD', 1);

    world.tick(ACTIONS.EAT_RAW);
    // 10 - hungerRate(0.005) + 3 = 12.995
    assert.ok(world.agent.food > 12.9);
    assert.equal(world.agent.totalFoodEaten, 1);

    world.modifyInventory('cooked_food', 1);
    world.agent.food = 10;
    world.tick(ACTIONS.EAT_COOKED);
    assert.ok(world.agent.food > 15.9);
    assert.equal(world.agent.totalFoodEaten, 2);
  });

  test('metrics calculation is populated', () => {
    const world = new SimWorld({}, 12345);
    world.modifyInventory('WOOD', 2);
    world.agent.tools.add('wooden_pickaxe');

    const metrics = world.getMetrics();
    assert.equal(typeof metrics.ticksSurvived, 'number');
    assert.ok(metrics.inventoryValue > 0);
    assert.equal(metrics.toolCount, 1);
  });
});
