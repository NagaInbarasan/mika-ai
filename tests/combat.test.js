import test from 'node:test';
import assert from 'node:assert/strict';
import { EquipmentManager } from '../src/combat/equipment.js';
import { ThreatAnalyzer } from '../src/combat/threats.js';
import { CombatTactics } from '../src/combat/tactics.js';

test('EquipmentManager selects highest tier armor and weapons', () => {
  const equip = new EquipmentManager();

  const inventoryItems = [
    { name: 'leather_chestplate', count: 1 },
    { name: 'iron_chestplate', count: 1 },
    { name: 'diamond_chestplate', count: 1 },
    { name: 'iron_helmet', count: 1 },
    { name: 'wooden_sword', count: 1 },
    { name: 'iron_sword', count: 1 },
    { name: 'diamond_sword', count: 1 },
    { name: 'shield', count: 1 }
  ];

  const bestChest = equip.getBestArmor(inventoryItems, 'chestplate');
  assert.strictEqual(bestChest.name, 'diamond_chestplate');

  const bestHelmet = equip.getBestArmor(inventoryItems, 'helmet');
  assert.strictEqual(bestHelmet.name, 'iron_helmet');

  const bestWeapon = equip.getBestWeapon(inventoryItems);
  assert.strictEqual(bestWeapon.name, 'diamond_sword');
});

test('EquipmentManager auto-equips gear into armor, mainhand, and offhand slots', async () => {
  const equip = new EquipmentManager();
  const equippedSlots = {};

  const mockBot = {
    inventory: {
      items: () => [
        { name: 'iron_helmet', count: 1 },
        { name: 'iron_chestplate', count: 1 },
        { name: 'iron_leggings', count: 1 },
        { name: 'iron_boots', count: 1 },
        { name: 'diamond_sword', count: 1 },
        { name: 'shield', count: 1 }
      ]
    },
    equip: async (item, dest) => {
      equippedSlots[dest] = item.name;
    }
  };

  const result = await equip.autoEquip(mockBot);
  assert.strictEqual(result.status, 'success');
  assert.strictEqual(result.has_full_armor, true);
  assert.strictEqual(result.has_weapon, true);
  assert.strictEqual(result.has_shield, true);
  assert.strictEqual(equippedSlots['head'], 'iron_helmet');
  assert.strictEqual(equippedSlots['torso'], 'iron_chestplate');
  assert.strictEqual(equippedSlots['hand'], 'diamond_sword');
  assert.strictEqual(equippedSlots['off-hand'], 'shield');
});

test('ThreatAnalyzer prioritizes creepers, skeletons, and hostile mobs by danger', () => {
  const analyzer = new ThreatAnalyzer();

  const mockBot = {
    entity: { position: { x: 0, y: 64, z: 0 } },
    entities: {
      1: { id: 1, name: 'cow', position: { x: 2, y: 64, z: 0, distanceTo: () => 2 } }, // Passive
      2: { id: 2, name: 'zombie', position: { x: 5, y: 64, z: 0, distanceTo: () => 5 } },
      3: { id: 3, name: 'creeper', position: { x: 4, y: 64, z: 0, distanceTo: () => 4 } },
      4: { id: 4, name: 'skeleton', position: { x: 8, y: 64, z: 0, distanceTo: () => 8 } }
    }
  };

  const threats = analyzer.evaluateThreats(mockBot, 16);
  assert.strictEqual(threats.length, 3); // creeper, skeleton, zombie
  // Creeper has priority 1, so it should rank first
  assert.strictEqual(threats[0].name, 'creeper');
  assert.strictEqual(threats[1].name, 'skeleton');
  assert.strictEqual(threats[2].name, 'zombie');

  // Creeper tactical recommendation
  const creeperTactic = analyzer.recommendTactic(threats[0], 20);
  assert.strictEqual(creeperTactic.tactic, 'hit_and_retreat');

  // Skeleton tactical recommendation
  const skeletonTactic = analyzer.recommendTactic(threats[1], 20);
  assert.strictEqual(skeletonTactic.useShield, true);

  // Critical health tactical recommendation overrides with retreat
  const lowHealthTactic = analyzer.recommendTactic(threats[2], 6.0);
  assert.strictEqual(lowHealthTactic.shouldRetreat, true);
  assert.strictEqual(lowHealthTactic.tactic, 'retreat_and_heal');
});

test('CombatTactics enforces health retreat threshold below 8 HP', async () => {
  const tactics = new CombatTactics();

  let retreatCalled = false;
  const mockLowHealthBot = {
    health: 6.0,
    food: 14,
    entity: { position: { x: 0, y: 64, z: 0 } },
    inventory: {
      items: () => [{ name: 'bread', count: 4 }]
    },
    equip: async () => {},
    consume: async () => { retreatCalled = true; },
    pathfinder: {
      setMovements: () => {},
      goto: async () => {}
    }
  };

  const target = { name: 'zombie', position: { x: 2, y: 64, z: 0 } };
  const res = await tactics.executeAttack(mockLowHealthBot, target);

  assert.strictEqual(res.status, 'success');
  assert.strictEqual(res.data.action, 'retreat_and_heal');
  assert.strictEqual(retreatCalled, true);
});
