import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { MinecraftAdapter, RESOURCE_CATEGORIES } from '../src/evolution/minecraft-adapter.js';
import { ACTIONS } from '../src/evolution/world.js';
import { Policy } from '../src/evolution/policy.js';

describe('MinecraftAdapter', () => {
  test('classifies Minecraft items into simplified resource categories', () => {
    const adapter = new MinecraftAdapter();

    assert.equal(adapter.classifyItem('oak_log'), RESOURCE_CATEGORIES.WOOD);
    assert.equal(adapter.classifyItem('spruce_planks'), RESOURCE_CATEGORIES.WOOD);
    assert.equal(adapter.classifyItem('stick'), RESOURCE_CATEGORIES.WOOD);

    assert.equal(adapter.classifyItem('cobblestone'), RESOURCE_CATEGORIES.STONE);
    assert.equal(adapter.classifyItem('deepslate'), RESOURCE_CATEGORIES.STONE);

    assert.equal(adapter.classifyItem('cooked_beef'), RESOURCE_CATEGORIES.FOOD);
    assert.equal(adapter.classifyItem('apple'), RESOURCE_CATEGORIES.FOOD);
    assert.equal(adapter.classifyItem('bread'), RESOURCE_CATEGORIES.FOOD);

    assert.equal(adapter.classifyItem('iron_ingot'), RESOURCE_CATEGORIES.IRON);
    assert.equal(adapter.classifyItem('raw_iron'), RESOURCE_CATEGORIES.IRON);

    assert.equal(adapter.classifyItem('coal'), RESOURCE_CATEGORIES.COAL);
    assert.equal(adapter.classifyItem('charcoal'), RESOURCE_CATEGORIES.COAL);

    assert.equal(adapter.classifyItem('diamond'), null);
  });

  test('aggregates inventory into categorized counts', () => {
    const adapter = new MinecraftAdapter();
    const inventory = [
      { name: 'oak_log', count: 4 },
      { name: 'stick', count: 2 },
      { name: 'cobblestone', count: 12 },
      { name: 'cooked_beef', count: 5 },
      { name: 'raw_iron', count: 3 },
      { name: 'coal', count: 8 }
    ];

    const aggregated = adapter.aggregateInventory(inventory);
    assert.equal(aggregated.WOOD, 6);
    assert.equal(aggregated.STONE, 12);
    assert.equal(aggregated.FOOD, 5);
    assert.equal(aggregated.IRON, 3);
    assert.equal(aggregated.COAL, 8);
  });

  test('translates Mineflayer observation to 19-element feature vector', () => {
    const adapter = new MinecraftAdapter();
    const mockObs = {
      agent: { health: 20, food: 20, position: { x: 10, y: 64, z: 20 } },
      environment: { is_night: false, time: 6000 },
      inventory: [
        { name: 'oak_log', count: 5 },
        { name: 'bread', count: 2 }
      ],
      nearbyThreats: [
        { name: 'zombie', distance: 6 }
      ],
      nearbyResources: [
        { name: 'oak_log', distance: 1.2 }
      ],
      shelterSafety: { safe: true }
    };

    const features = adapter.translateObservation(mockObs);
    assert.ok(features instanceof Float64Array);
    assert.equal(features.length, 19);

    assert.equal(features[0], 1.0); // health 20/20
    assert.equal(features[1], 1.0); // food 20/20
    assert.equal(features[2], 0.0); // day
    assert.equal(features[4], 0.2); // 1 threat / 5
    assert.equal(features[5], 1.0); // hasWood
    assert.equal(features[7], 1.0); // hasFood
    assert.equal(features[11], 1.0); // hasShelter
  });

  test('translates movement and combat policy actions to Mineflayer schema', () => {
    const adapter = new MinecraftAdapter();
    const mockObs = {
      agent: { position: { x: 100, y: 64, z: 200 } },
      nearbyThreats: [{ name: 'skeleton', distance: 5 }]
    };

    const planNorth = adapter.translateAction(ACTIONS.MOVE_NORTH, mockObs);
    assert.equal(planNorth.action, 'navigate_to');
    assert.equal(planNorth.arguments.x, 100);
    assert.equal(planNorth.arguments.z, 196);
    assert.ok(planNorth.goal);
    assert.ok(planNorth.reason_summary);

    const planAttack = adapter.translateAction(ACTIONS.ATTACK, mockObs);
    assert.equal(planAttack.action, 'attack_target');
    assert.equal(planAttack.arguments.target, 'skeleton');

    const planFlee = adapter.translateAction(ACTIONS.FLEE, mockObs);
    assert.equal(planFlee.action, 'retreat_and_heal');

    const planCraft = adapter.translateAction({ actionName: ACTIONS.CRAFT, craftTarget: 'wooden_pickaxe' }, mockObs);
    assert.equal(planCraft.action, 'craft_item');
    assert.equal(planCraft.arguments.item, 'wooden_pickaxe');

    const planEat = adapter.translateAction(ACTIONS.EAT_RAW, {
      inventory: [{ name: 'apple', count: 1 }]
    });
    assert.equal(planEat.action, 'eat_food');
    assert.equal(planEat.arguments.item, 'apple');
  });

  test('generates full plan through policy.selectAction() pipeline', () => {
    const policy = new Policy();
    const adapter = new MinecraftAdapter(policy);

    const mockObs = {
      agent: { health: 18, food: 15, position: { x: 0, y: 64, z: 0 } },
      environment: { isDay: true },
      inventory: [{ name: 'bread', count: 3 }],
      nearbyEntities: [],
      nearbyResources: []
    };

    const plan = adapter.generatePlan(mockObs);
    assert.ok(plan);
    assert.ok(plan.action);
    assert.ok(plan.arguments);
    assert.ok(plan.goal);
    assert.ok(plan.reason_summary);
  });
});
