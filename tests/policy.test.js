import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractFeatures,
  Policy,
  RandomPolicy,
  HeuristicPolicy,
  ACTION_DEFINITIONS,
  getActionIndex,
  CRAFT_TARGETS
} from '../src/evolution/policy.js';
import { SimWorld, ACTIONS, SeededRandom } from '../src/evolution/world.js';

describe('Feature Extraction', () => {
  test('produces Float64Array of length 19 with valid default observation', () => {
    const world = new SimWorld({}, 42);
    const obs = world.getObservation();
    const features = extractFeatures(obs);

    assert.ok(features instanceof Float64Array);
    assert.equal(features.length, 19);

    // Initial state: 20 health, 20 food -> 1.0
    assert.equal(features[0], 1.0); // healthNorm
    assert.equal(features[1], 1.0); // foodNorm
    assert.equal(features[2], 0.0); // isNight
    assert.equal(features[16], 0.0); // foodUrgency
    assert.equal(features[17], 0.0); // healthUrgency
    assert.equal(features[18], 0.0); // tickProgress
  });

  test('normalizes health, food, urgency and inventory correctly', () => {
    const mockObs = {
      agent: { health: 10, food: 5, alive: true },
      inventory: { WOOD: 4, STONE: 0, FOOD: 2, IRON: 1 },
      tools: ['wooden_pickaxe'],
      currentCell: { resource: { type: 'WOOD', amount: 1 }, threat: null, shelter: false },
      nearbyResources: [{ distance: 2 }, { distance: 3 }],
      nearbyThreats: [{ distance: 1 }],
      hasShelter: false,
      shelterDistance: -1,
      isNight: true,
      tick: 600,
      maxHealth: 20,
      maxFood: 20,
      gridSize: 64,
      maxTicks: 2400
    };

    const f = extractFeatures(mockObs);

    assert.equal(f[0], 0.5); // health 10/20
    assert.equal(f[1], 0.25); // food 5/20
    assert.equal(f[2], 1.0); // isNight
    assert.equal(f[3], 0.2); // 2 resources / 10
    assert.equal(f[4], 0.2); // 1 threat / 5
    assert.equal(f[5], 1.0); // hasWood
    assert.equal(f[6], 0.0); // hasStone
    assert.equal(f[7], 1.0); // hasFood
    assert.equal(f[8], 1.0); // hasIron
    assert.equal(f[9], 1.0); // currentCellHasResource
    assert.equal(f[10], 0.0); // currentCellHasThreat
    assert.equal(f[11], 0.0); // hasShelter
    assert.equal(f[12], 0.0); // shelterDistance
    assert.equal(f[13], 1.0); // hasPickaxe
    assert.equal(f[14], 0.0); // hasSword
    assert.equal(f[15], 1.0); // canCraftAnything (wood >= 3 for wooden_pickaxe)
    assert.equal(f[16], 0.75); // foodUrgency 1 - 0.25
    assert.equal(f[17], 0.5); // healthUrgency 1 - 0.5
    assert.equal(f[18], 0.25); // tickProgress 600/2400
  });

  test('caps nearby counts properly', () => {
    const mockObs = {
      nearbyResources: new Array(15).fill({ distance: 1 }),
      nearbyThreats: new Array(10).fill({ distance: 1 })
    };

    const f = extractFeatures(mockObs);
    assert.equal(f[3], 1.0); // capped at 10/10
    assert.equal(f[4], 1.0); // capped at 5/5
  });
});

describe('Action Definitions and Indexing', () => {
  test('has exactly 19 action definitions', () => {
    assert.equal(ACTION_DEFINITIONS.length, 19);
  });

  test('indexes base actions and craft actions accurately', () => {
    assert.equal(getActionIndex(ACTIONS.MOVE_NORTH), 0);
    assert.equal(getActionIndex(ACTIONS.MOVE_WEST), 3);
    assert.equal(getActionIndex(ACTIONS.GATHER), 4);
    assert.equal(getActionIndex(ACTIONS.EAT_RAW), 5);
    assert.equal(getActionIndex(ACTIONS.IDLE), 12);

    for (let i = 0; i < CRAFT_TARGETS.length; i++) {
      const target = CRAFT_TARGETS[i];
      assert.equal(getActionIndex(ACTIONS.CRAFT, target), 13 + i);
    }
  });
});

describe('Policy Class', () => {
  test('initializes with default sizes and shapes', () => {
    const policy = new Policy();
    assert.equal(policy.numFeatures, 19);
    assert.equal(policy.numActions, 19);
    assert.equal(policy.weights.length, 19 * 19);
    assert.equal(policy.biases.length, 19);
    assert.equal(policy.generation, 0);
    assert.equal(policy.parentId, null);
    assert.equal(policy.fitness, 0);
  });

  test('selectAction returns well-formed action and valid probabilities', () => {
    const policy = new Policy();
    const features = new Float64Array(19).fill(0.5);

    const action = policy.selectAction(features, { greedy: true });
    assert.ok(action.actionIndex >= 0 && action.actionIndex < 19);
    assert.ok(typeof action.actionName === 'string');
    assert.ok(action.confidence > 0 && action.confidence <= 1.0);
  });

  test('sampling selection explores actions based on rng', () => {
    const rng = new SeededRandom(101);
    const policy = new Policy();
    const features = new Float64Array(19).fill(0.1);

    const actionsSampled = new Set();
    for (let i = 0; i < 50; i++) {
      const a = policy.selectAction(features, { greedy: false, rng });
      actionsSampled.add(a.actionIndex);
    }
    // Should have explored multiple actions
    assert.ok(actionsSampled.size > 1);
  });

  test('createRandom produces deterministic policies from seed', () => {
    const p1 = Policy.createRandom(999);
    const p2 = Policy.createRandom(999);

    assert.deepEqual(Array.from(p1.weights), Array.from(p2.weights));
    assert.deepEqual(Array.from(p1.biases), Array.from(p2.biases));

    const p3 = Policy.createRandom(1000);
    assert.notDeepEqual(Array.from(p1.weights), Array.from(p3.weights));
  });

  test('mutate generates perturbed child with incremented generation', () => {
    const parent = Policy.createRandom(42);
    const rng = new SeededRandom(77);
    const child = parent.mutate(0.2, 0.5, rng);

    assert.equal(child.generation, parent.generation + 1);
    assert.equal(child.parentId, parent.id);
    assert.notEqual(child.id, parent.id);
    assert.equal(child.fitness, 0);

    // Some weights should be different due to mutation
    let diffCount = 0;
    for (let i = 0; i < parent.weights.length; i++) {
      if (parent.weights[i] !== child.weights[i]) diffCount++;
    }
    assert.ok(diffCount > 0);
  });

  test('crossover combines weights from two parents', () => {
    const p1 = Policy.createRandom(111);
    const p2 = Policy.createRandom(222);
    p1.generation = 2;
    p2.generation = 4;

    const rng = new SeededRandom(333);
    const offspring = p1.crossover(p2, rng);

    assert.equal(offspring.generation, 5); // max(2, 4) + 1
    assert.notEqual(offspring.id, p1.id);
    assert.notEqual(offspring.id, p2.id);

    // Every weight must come from either p1 or p2
    for (let i = 0; i < offspring.weights.length; i++) {
      const matchesP1 = offspring.weights[i] === p1.weights[i];
      const matchesP2 = offspring.weights[i] === p2.weights[i];
      assert.ok(matchesP1 || matchesP2);
    }
  });

  test('clone and serialization round-trip', () => {
    const policy = Policy.createRandom(555, { metadata: { tag: 'elite' } });
    policy.fitness = 150.5;

    const cloned = policy.clone();
    assert.notEqual(cloned.id, policy.id);
    assert.equal(cloned.fitness, policy.fitness);
    assert.deepEqual(Array.from(cloned.weights), Array.from(policy.weights));

    const serialized = policy.serialize();
    const deserialized = Policy.deserialize(serialized);

    assert.equal(deserialized.id, policy.id);
    assert.equal(deserialized.fitness, policy.fitness);
    assert.deepEqual(Array.from(deserialized.weights), Array.from(policy.weights));
    assert.deepEqual(deserialized.metadata, policy.metadata);
  });
});

describe('RandomPolicy', () => {
  test('picks valid random actions uniformly', () => {
    const randPolicy = new RandomPolicy();
    const action = randPolicy.selectAction();

    assert.ok(action.actionIndex >= 0 && action.actionIndex < 19);
    assert.ok(typeof action.actionName === 'string');
    assert.equal(action.confidence, 1 / 19);
  });

  test('deterministic with SeededRandom', () => {
    const randPolicy = new RandomPolicy();
    const a1 = randPolicy.selectAction(null, { rng: new SeededRandom(50) });
    const a2 = randPolicy.selectAction(null, { rng: new SeededRandom(50) });

    assert.equal(a1.actionIndex, a2.actionIndex);
  });
});

describe('HeuristicPolicy Survival Rules', () => {
  const hp = new HeuristicPolicy();

  test('Rule 1: If health < 5 and has food -> eats', () => {
    const obs = {
      agent: { health: 4, food: 15 },
      inventory: { FOOD: 2, cooked_food: 0 }
    };
    const act = hp.selectAction(obs);
    assert.equal(act.actionName, ACTIONS.EAT_RAW);

    // Prefers cooked food if available
    obs.inventory.cooked_food = 1;
    const actCooked = hp.selectAction(obs);
    assert.equal(actCooked.actionName, ACTIONS.EAT_COOKED);
  });

  test('Rule 2: If food < 8 and has food -> eats', () => {
    const obs = {
      agent: { health: 15, food: 7 },
      inventory: { FOOD: 1 }
    };
    const act = hp.selectAction(obs);
    assert.equal(act.actionName, ACTIONS.EAT_RAW);
  });

  test('Rule 3 & 4: Threat response depends on weapon', () => {
    // Threat without sword -> flee
    const obsFlee = {
      agent: { health: 20, food: 20 },
      nearbyThreats: [{ distance: 2 }],
      tools: []
    };
    assert.equal(hp.selectAction(obsFlee).actionName, ACTIONS.FLEE);

    // Threat with sword -> attack
    const obsAttack = {
      agent: { health: 20, food: 20 },
      nearbyThreats: [{ distance: 2 }],
      tools: ['wooden_sword']
    };
    assert.equal(hp.selectAction(obsAttack).actionName, ACTIONS.ATTACK);
  });

  test('Rule 5: If night and has shelter -> goto_shelter', () => {
    const obs = {
      agent: { health: 20, food: 20 },
      isNight: true,
      hasShelter: true
    };
    assert.equal(hp.selectAction(obs).actionName, ACTIONS.GOTO_SHELTER);
  });

  test('Rule 6: If night and no shelter and can craft shelter_kit -> craft shelter_kit', () => {
    const obs = {
      agent: { health: 20, food: 20 },
      isNight: true,
      hasShelter: false,
      inventory: { WOOD: 5, STONE: 3 }
    };
    const act = hp.selectAction(obs);
    assert.equal(act.actionName, ACTIONS.CRAFT);
    assert.equal(act.craftTarget, 'shelter_kit');
  });

  test('Rule 7: If has shelter_kit -> build_shelter', () => {
    const obs = {
      agent: { health: 20, food: 20 },
      hasShelter: false,
      inventory: { shelter_kit: 1 }
    };
    assert.equal(hp.selectAction(obs).actionName, ACTIONS.BUILD_SHELTER);
  });

  test('Rule 8: If current cell has resource -> gather', () => {
    const obs = {
      agent: { health: 20, food: 20 },
      currentCell: { resource: { type: 'WOOD', amount: 1 } }
    };
    assert.equal(hp.selectAction(obs).actionName, ACTIONS.GATHER);
  });

  test('Rule 9: If can craft useful tool -> craft it', () => {
    const obs = {
      agent: { health: 20, food: 20 },
      inventory: { STONE: 3, WOOD: 2 },
      tools: []
    };
    const act = hp.selectAction(obs);
    assert.equal(act.actionName, ACTIONS.CRAFT);
    // Can craft stone_pickaxe or stone_sword
    assert.ok(act.craftTarget === 'stone_sword' || act.craftTarget === 'stone_pickaxe');
  });

  test('Rule 10: Otherwise -> move toward nearest resource', () => {
    const obs = {
      agent: { health: 20, food: 20 },
      nearbyResources: [
        { dx: 3, dy: 0, distance: 3 },
        { dx: 0, dy: 1, distance: 1 }
      ]
    };
    // Nearest resource is at dy: 1 -> MOVE_SOUTH
    const act = hp.selectAction(obs);
    assert.equal(act.actionName, ACTIONS.MOVE_SOUTH);
  });

  test('handles feature vector fallback gracefully', () => {
    const features = new Float64Array(19);
    features[0] = 0.1; // low health
    features[7] = 1.0; // has food
    const act = hp.selectAction(features);
    assert.equal(act.actionName, ACTIONS.EAT_RAW);
  });
});
