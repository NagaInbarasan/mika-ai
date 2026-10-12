import test from 'node:test';
import assert from 'node:assert/strict';
import { DragonFightController } from '../src/combat/dragon-tactics.js';

test('DragonFightController identifies crystals and prioritizes crystal destruction', () => {
  const controller = new DragonFightController();

  const mockBot = {
    entity: { position: { x: 0, y: 65, z: 20 } },
    inventory: {
      items: () => [
        { name: 'bow', count: 1 },
        { name: 'arrow', count: 32 }
      ]
    },
    entities: {
      1: { id: 1, name: 'end_crystal', position: { x: 10, y: 85, z: 10, distanceTo: () => 25 } },
      2: { id: 2, name: 'end_crystal', position: { x: -20, y: 80, z: -20, distanceTo: () => 45 } },
      3: { id: 3, name: 'ender_dragon', position: { x: 0, y: 90, z: 0, distanceTo: () => 35 }, health: 200 }
    }
  };

  const crystals = controller.findEndCrystals(mockBot);
  assert.strictEqual(crystals.length, 2);

  const tactics = controller.evaluateDragonTactics(mockBot);
  assert.strictEqual(tactics.phase, 'crystal_destruction_ranged');
  assert.strictEqual(tactics.recommended_action, 'shoot_crystal');
  assert.strictEqual(tactics.priority, 'critical');
});

test('DragonFightController detects perching attack window when crystals are clear', () => {
  const controller = new DragonFightController();

  const mockBot = {
    entity: { position: { x: 5, y: 65, z: 5 } },
    inventory: { items: () => [] },
    entities: {
      1: {
        id: 1,
        name: 'ender_dragon',
        position: { x: 2, y: 66, z: 2, distanceTo: () => 4 }, // Near central portal (0, 65, 0)
        health: 150
      }
    }
  };

  const dragonState = controller.getDragonState(mockBot);
  assert.strictEqual(dragonState.isPerching, true);

  const tactics = controller.evaluateDragonTactics(mockBot);
  assert.strictEqual(tactics.phase, 'perch_melee_attack_window');
  assert.strictEqual(tactics.recommended_action, 'attack_target');
  assert.strictEqual(tactics.priority, 'maximum_damage_window');
});
