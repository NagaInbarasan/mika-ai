/**
 * Swarm Role Specialization & Collaborative Decision Engine.
 * Implements deterministic heuristic planning for up to 4 specialized bot roles:
 * - GATHERER: Harvests wood, stone, food, delivers supplies.
 * - BUILDER: Crafts tools, builds shelters, sets up shared chests.
 * - GUARD: Defends team, monitors distress signals, rushes to rescue allies.
 * - EXPLORER: Scouts perimeter, maps resources, detects incoming threats.
 */

export const SWARM_ROLES = {
  GUARD: 'guard',
  BUILDER: 'builder',
  EXPLORER: 'explorer',
  FARMER: 'farmer',
  MINER: 'miner',
  CRAFTSMAN: 'craftsman',
  GATHERER: 'gatherer'
};

export const ROLE_CONFIGS = {
  [SWARM_ROLES.GUARD]: {
    title: 'Warrior & Guard',
    primaryDuty: 'Guarding all teammates from danger, active mob defense, and bodyguarding'
  },
  [SWARM_ROLES.BUILDER]: {
    title: 'Builder & Architect',
    primaryDuty: 'Constructing safe shelter, placing furniture, crafting weapons/shields/armor, and building farm plots'
  },
  [SWARM_ROLES.EXPLORER]: {
    title: 'Scout & Hunter',
    primaryDuty: 'Drawing map, marking waypoints, gathering wild food, hunting animals, and storing hunting supplies in separate chests'
  },
  [SWARM_ROLES.FARMER]: {
    title: 'Farmer & Cultivator',
    primaryDuty: 'Tending farm plots, tilling soil, planting seeds, harvesting crops, and storing food in dedicated food chests'
  },
  [SWARM_ROLES.MINER]: {
    title: 'Miner & Geologist',
    primaryDuty: 'Mining cobblestone, stone, coal, and iron ore, and depositing in dedicated mineral chests for crafting'
  },
  [SWARM_ROLES.CRAFTSMAN]: {
    title: 'Craftsman & Blacksmith',
    primaryDuty: 'Crafting weapons, shields, armor, and unlocking new recipes at the crafting table using mined resources'
  },
  [SWARM_ROLES.GATHERER]: {
    title: 'Farmer & Gatherer',
    primaryDuty: 'Resource harvesting, crop cultivation, and surplus sharing'
  }
};

/**
 * Assigns optimal roles based on swarm size (1 to 6 bots).
 * @param {number} totalBots
 * @returns {string[]} Array of role identifiers
 */
export function assignSwarmRoles(totalBots = 5) {
  const count = Math.max(1, Math.min(6, totalBots));
  switch (count) {
    case 1:
      return [SWARM_ROLES.GATHERER];
    case 2:
      return [SWARM_ROLES.GATHERER, SWARM_ROLES.GUARD];
    case 3:
      return [SWARM_ROLES.GATHERER, SWARM_ROLES.BUILDER, SWARM_ROLES.GUARD];
    case 4:
      return [SWARM_ROLES.GATHERER, SWARM_ROLES.BUILDER, SWARM_ROLES.GUARD, SWARM_ROLES.EXPLORER];
    case 5:
      return [SWARM_ROLES.GATHERER, SWARM_ROLES.BUILDER, SWARM_ROLES.GUARD, SWARM_ROLES.EXPLORER, SWARM_ROLES.MINER];
    case 6:
    default:
      return [SWARM_ROLES.GATHERER, SWARM_ROLES.BUILDER, SWARM_ROLES.GUARD, SWARM_ROLES.EXPLORER, SWARM_ROLES.MINER, SWARM_ROLES.CRAFTSMAN];
  }
}

/**
 * Heuristic planner for swarm agents operating without LLM (zero latency, high speed).
 */
export class SwarmRolePlanner {
  constructor() {
    this.name = 'swarm_role_planner';
  }

  /**
   * Proposes a collaborative, role-specialized action.
   * @param {Object} params
   * @param {import('mineflayer').Bot} params.bot
   * @param {string} params.role
   * @param {Object} params.observation
   * @param {import('./blackboard.js').SwarmBlackboard} params.blackboard
   * @param {import('./message-bus.js').SwarmMessageBus} params.messageBus
   * @returns {Object} Deterministic decision object
   */
  proposeAction({ bot, role, observation, blackboard, messageBus }) {
    if (!observation || !observation.agent) {
      return {
        goal: 'idle',
        action: 'stop',
        arguments: {},
        reason_summary: 'No observation available',
        expected_outcome: 'safe idle',
        risk: 'low',
        confidence: 1.0
      };
    }

    const agent = observation.agent;
    const threats = observation.nearby_threats || [];
    const inv = observation.inventory || [];
    const botName = bot.username || 'Bot';

    // 1. Critical Survival & Distress Signaling (All Roles)
    if (agent.health <= 8.0 && threats.length > 0) {
      const primaryThreat = threats[0];
      if (blackboard) {
        blackboard.postDistressCall({
          botName,
          position: agent.position,
          mobName: primaryThreat.name,
          health: agent.health
        });
      }
      if (messageBus) {
        messageBus.sendDistress(bot, primaryThreat.name, agent.health, agent.position);
      }

      // If shelter exists on blackboard, retreat toward it
      const shelter = blackboard ? blackboard.getShelter() : null;
      if (shelter) {
        return {
          goal: 'retreat to swarm shelter',
          action: 'navigate_to',
          arguments: { x: shelter.x, y: shelter.y, z: shelter.z, range: 2.0 },
          reason_summary: `Low health (${agent.health}/20) and threat detected; retreating to shelter.`,
          expected_outcome: 'reaches shelter safe zone',
          risk: 'medium',
          confidence: 1.0
        };
      }

      return {
        goal: 'tactical retreat from threat',
        action: 'retreat_and_heal',
        arguments: {},
        reason_summary: `Low health (${agent.health}/20); executing tactical retreat.`,
        expected_outcome: 'distance to threat increases and health regenerates',
        risk: 'medium',
        confidence: 1.0
      };
    }

    // 2. Hunger check with Food Supply Chain (All Roles)
    //    Step 1: Eat from inventory
    //    Step 2: Navigate to food chest and withdraw
    //    Step 3: Request food from Farmer/Explorer
    if (agent.food <= 14) {
      const EDIBLE_FOOD = ['bread', 'cooked_beef', 'apple', 'baked_potato', 'sweet_berries',
        'cooked_porkchop', 'cooked_chicken', 'cooked_mutton', 'cooked_rabbit', 'cooked_cod',
        'cooked_salmon', 'golden_apple', 'golden_carrot', 'melon_slice', 'dried_kelp',
        'mushroom_stew', 'beetroot_soup', 'rabbit_stew', 'cookie', 'pumpkin_pie', 'cake',
        'carrot', 'potato', 'beetroot', 'wheat', 'beef', 'porkchop', 'chicken', 'mutton',
        'rabbit', 'cod', 'salmon'];
      const hasFood = inv.some(i => EDIBLE_FOOD.includes(i.name));

      // Step 1: Eat food from inventory
      if (hasFood) {
        return {
          goal: 'restore hunger',
          action: 'eat_food',
          arguments: {},
          reason_summary: `Hunger is low (${agent.food}/20); consuming food from inventory.`,
          expected_outcome: 'food level increases',
          risk: 'low',
          confidence: 1.0
        };
      }

      // Step 2: Check food chest nearby and withdraw food
      if (blackboard) {
        const foodChest = blackboard.getNearestChest(agent.position, 'food');
        if (foodChest) {
          if (foodChest.distance <= 6.0) {
            return {
              goal: 'withdraw food from food chest',
              action: 'withdraw_from_chest',
              arguments: { item: 'cooked_beef', count: 3 },
              reason_summary: `No food in inventory. Withdrawing rations from nearby food chest.`,
              expected_outcome: 'food items withdrawn into inventory',
              risk: 'low',
              confidence: 0.9
            };
          } else if (foodChest.distance <= 24.0) {
            return {
              goal: 'navigate to food chest for rations',
              action: 'navigate_to',
              arguments: { x: foodChest.x, y: foodChest.y, z: foodChest.z, range: 3.0 },
              reason_summary: `Hungry (${agent.food}/20) with no food. Walking to food chest at (${foodChest.x}, ${foodChest.z}).`,
              expected_outcome: 'reaches food chest to withdraw rations',
              risk: 'low',
              confidence: 0.9
            };
          }
        }

        // Step 3: Request food from Farmer or Explorer via blackboard
        const urgency = agent.food <= 6 ? 'critical' : 'normal';
        const existingFoodReq = blackboard.getActiveFoodRequests
          ? blackboard.getActiveFoodRequests().find(r => r.botName === botName)
          : null;

        if (!existingFoodReq && typeof blackboard.postFoodRequest === 'function') {
          blackboard.postFoodRequest({
            botName,
            position: agent.position,
            urgency
          });
        }

        if (messageBus) {
          messageBus.requestResource(bot, 'food', 1, agent.position);
        }
      }
    }

    // 3. Nighttime Shelter Recall (All Roles except Guard on patrol)
    const env = observation.environment || {};
    const isNight = env.isDay === false;
    const shelter = blackboard ? blackboard.getShelter() : null;

    if (isNight && shelter && role !== SWARM_ROLES.GUARD) {
      const distToShelter = Math.hypot(agent.position.x - shelter.x, agent.position.z - shelter.z);
      if (distToShelter > 3.0) {
        return {
          goal: 'seek shelter during night',
          action: 'navigate_to',
          arguments: { x: shelter.x, y: shelter.y, z: shelter.z, range: 2.0 },
          reason_summary: `Night has fallen; moving to shared shelter safe zone.`,
          expected_outcome: 'arrives inside shelter',
          risk: 'low',
          confidence: 1.0
        };
      }
    }

    // 4. Role-Specific Deliberation
    switch (role) {
      case SWARM_ROLES.GUARD:
        return this._planGuard({ bot, observation, blackboard, messageBus });

      case SWARM_ROLES.BUILDER:
      case SWARM_ROLES.CRAFTSMAN:
        return this._planBuilder({ bot, observation, blackboard, messageBus });

      case SWARM_ROLES.MINER:
        return this._planMiner({ bot, observation, blackboard, messageBus });

      case SWARM_ROLES.FARMER:
      case SWARM_ROLES.GATHERER:
        return this._planFarmer({ bot, observation, blackboard, messageBus });

      case SWARM_ROLES.EXPLORER:
        return this._planExplorer({ bot, observation, blackboard, messageBus });

      default:
        return this._planFarmer({ bot, observation, blackboard, messageBus });
    }
  }

  // --- Role Implementations ---

  _planGuard({ bot, observation, blackboard, messageBus }) {
    const threats = observation.nearby_threats || [];
    const agent = observation.agent;
    const inv = observation.inventory || [];

    // Guard Priority 1: Check active distress calls from ANY teammate
    if (blackboard) {
      const distressCalls = blackboard.getActiveDistressCalls();
      if (distressCalls.length > 0) {
        const call = distressCalls[0];
        blackboard.claimDistressCall(call.id, bot.username);
        return {
          goal: `rescue teammate ${call.botName}`,
          action: 'assist_teammate',
          arguments: { teammate: call.botName, x: call.position.x, z: call.position.z },
          reason_summary: `Distress signal from ${call.botName} under attack by ${call.mobName}! Rushing to assist.`,
          expected_outcome: 'protects teammate and engages threat',
          risk: 'medium',
          confidence: 1.0
        };
      }
    }

    // Guard Priority 2: Engage immediate nearby hostile mobs
    if (threats.length > 0) {
      const targetMob = threats[0];
      // Tactical defense if health is taking hits
      if (agent.health <= 10.0) {
        return {
          goal: `shield block and retreat from ${targetMob.name}`,
          action: 'defend_with_shield',
          arguments: { duration_ms: 2000 },
          reason_summary: `Health reduced to ${agent.health}/20; raising offhand shield to absorb attacks before retaliating.`,
          expected_outcome: 'shield absorbs damage',
          risk: 'medium',
          confidence: 0.95
        };
      }

      // Record creature encounter for team learning
      if (blackboard && typeof blackboard.recordCreatureEncounter === 'function') {
        blackboard.recordCreatureEncounter({
          creature: targetMob.name,
          x: targetMob.position?.x || agent.position.x,
          y: targetMob.position?.y || agent.position.y,
          z: targetMob.position?.z || agent.position.z,
          killed: false,
          reportedBy: bot.username
        });
      }

      return {
        goal: `engage hostile ${targetMob.name}`,
        action: 'attack_target',
        arguments: { mob: targetMob.name },
        reason_summary: `Hostile mob ${targetMob.name} spotted at ${targetMob.distance}m; engaging with attack cooldowns.`,
        expected_outcome: 'hostile mob damaged or defeated',
        risk: 'medium',
        confidence: 0.95
      };
    }

    // Guard Priority 3: Proactively intercept threats near ANY teammate
    if (blackboard) {
      const allMembers = blackboard.getAllMembers().filter(m => m.name !== bot.username && m.isAlive && m.position);
      const activeThreats = blackboard.getActiveThreats();
      if (activeThreats.length > 0 && allMembers.length > 0) {
        for (const threat of activeThreats) {
          const nearestAlly = allMembers.find(m => Math.hypot(m.position.x - threat.x, m.position.z - threat.z) <= 16.0);
          if (nearestAlly) {
            return {
              goal: `intercept threat ${threat.mob} near ${nearestAlly.name}`,
              action: 'assist_teammate',
              arguments: { teammate: nearestAlly.name, x: threat.x, z: threat.z },
              reason_summary: `Detected ${threat.mob} within 16m of teammate ${nearestAlly.name}. Mobilizing to eliminate danger.`,
              expected_outcome: 'intercepts hostile before teammate takes damage',
              risk: 'medium',
              confidence: 0.95
            };
          }
        }
      }
    }

    // Guard Priority 4: Guard lost items of fallen teammates
    if (blackboard) {
      const lost = blackboard.getLostThings();
      if (lost) {
        const distToLost = Math.hypot(agent.position.x - lost.x, agent.position.z - lost.z);
        if (distToLost > 4.0) {
          return {
            goal: `secure lost items of ${lost.botName}`,
            action: 'navigate_to',
            arguments: { x: lost.x, y: lost.y, z: lost.z, range: 3.0 },
            reason_summary: `Securing perimeter around ${lost.botName}'s death location to protect dropped equipment.`,
            expected_outcome: 'reaches death site to guard gear',
            risk: 'low',
            confidence: 0.9
          };
        }
      }
    }

    // Guard Priority 5: Equipment check
    const hasSword = inv.some(i => i.name.includes('sword'));
    const hasShield = inv.some(i => i.name.includes('shield'));
    if (!hasSword || !hasShield) {
      return {
        goal: 'optimize combat gear',
        action: 'equip_gear',
        arguments: {},
        reason_summary: 'Equipping highest available tier weapons, armor, and shield.',
        expected_outcome: 'weapons and armor equipped',
        risk: 'low',
        confidence: 0.9
      };
    }

    // Guard Priority 6: Dynamic Bodyguard Escort (Guard EVERY active teammate)
    if (blackboard) {
      const allies = blackboard.getAllMembers().filter(m => m.name !== bot.username && m.isAlive && m.position);
      if (allies.length > 0) {
        // Protect the most vulnerable teammate (lowest HP or furthest from base)
        allies.sort((a, b) => (a.health || 20) - (b.health || 20));
        const protectTarget = allies[0];
        const dist = Math.hypot(agent.position.x - protectTarget.position.x, agent.position.z - protectTarget.position.z);
        if (dist > 7.0) {
          return {
            goal: `bodyguard escort teammate ${protectTarget.name}`,
            action: 'navigate_to',
            arguments: { x: protectTarget.position.x, y: protectTarget.position.y, z: protectTarget.position.z, range: 4.0 },
            reason_summary: `Providing active bodyguard escort for teammate ${protectTarget.name} (${protectTarget.role}).`,
            expected_outcome: 'maintains defensive perimeter around teammate',
            risk: 'low',
            confidence: 0.85
          };
        }
      }
    }

    return {
      goal: 'guard sentry watch',
      action: 'look_around',
      arguments: { yaw: agent.yaw + 1.57 },
      reason_summary: 'Sentry duty: scanning horizon and perimeter for hostile threats.',
      expected_outcome: 'threat radar refreshed',
      risk: 'low',
      confidence: 0.8
    };
  }

  _planBuilder({ bot, observation, blackboard, messageBus }) {
    const inv = observation.inventory || [];
    const agent = observation.agent;
    const dirtCount = this._countItem(inv, 'dirt');
    const cobbleCount = this._countItem(inv, 'cobblestone');
    const logsCount = this._countItem(inv, 'log') + this._countItem(inv, 'wood');
    const planksCount = this._countItem(inv, 'planks');
    const woolCount = this._countItem(inv, 'wool');
    const coalCount = this._countItem(inv, 'coal') + this._countItem(inv, 'charcoal');
    const hasTableInInv = inv.some(i => i.name === 'crafting_table');
    const hasChestInInv = inv.some(i => i.name === 'chest');
    const hasFurnaceInInv = inv.some(i => i.name === 'furnace');
    const hasBedInInv = inv.some(i => i.name === 'bed');
    const hasTorchesInInv = inv.some(i => i.name === 'torch');

    // 0. Auto pickup nearby dropped items (from teammates handoffs)
    let droppedItem = null;
    if (bot.entities) {
      for (const id in bot.entities) {
        const ent = bot.entities[id];
        if (ent && (ent.name === 'item' || ent.type === 'object') && ent.position && bot.entity?.position) {
          const d = Math.hypot(ent.position.x - bot.entity.position.x, ent.position.z - bot.entity.position.z);
          if (d <= 6.0) {
            droppedItem = ent;
            break;
          }
        }
      }
    }
    if (droppedItem) {
      return {
        goal: 'pick up delivered dropped items',
        action: 'navigate_to',
        arguments: { x: droppedItem.position.x, y: droppedItem.position.y, z: droppedItem.position.z, range: 1.0 },
        reason_summary: 'Walking to collect delivered items dropped on ground by teammates.',
        expected_outcome: 'items collected into inventory',
        risk: 'low',
        confidence: 0.95
      };
    }

    // 1. Emergency Shelter Construction
    const existingShelter = blackboard ? blackboard.getShelter() : null;
    if (!existingShelter && (dirtCount + cobbleCount >= 6)) {
      return {
        goal: 'construct swarm shelter',
        action: 'place_block',
        arguments: { block: dirtCount >= 4 ? 'dirt' : 'cobblestone', dx: 1, dy: 0, dz: 0 },
        reason_summary: 'Constructing shared emergency shelter enclosure for the swarm.',
        expected_outcome: 'shelter walls established',
        risk: 'low',
        confidence: 0.95
      };
    }

    // 2. FURNITURE: Crafting Table Workbench
    const placedWorkbench = blackboard ? blackboard.getFurniture('crafting_table') : null;
    if (!placedWorkbench) {
      if (hasTableInInv) {
        return {
          goal: 'place crafting table furniture',
          action: 'place_block',
          arguments: { item: 'crafting_table', dx: 1, dy: 0, dz: 1 },
          reason_summary: 'Placing shared crafting table furniture at base camp.',
          expected_outcome: 'crafting table furniture positioned',
          risk: 'low',
          confidence: 0.95
        };
      }
      if (planksCount >= 4) {
        return {
          goal: 'craft crafting table furniture',
          action: 'craft_item',
          arguments: { item: 'crafting_table', count: 1 },
          reason_summary: 'Crafting workbench furniture for team crafting recipes.',
          expected_outcome: 'inventory contains crafting table',
          risk: 'low',
          confidence: 0.95
        };
      }
      if (logsCount > 0) {
        return {
          goal: 'craft planks for furniture',
          action: 'craft_item',
          arguments: { item: 'planks', count: 1 },
          reason_summary: 'Converting wood logs into planks for furniture construction.',
          expected_outcome: 'inventory contains planks',
          risk: 'low',
          confidence: 0.95
        };
      }
    }

    // 3. FURNITURE: Storage Chests (Categorized for Food and Minerals/Armory)
    const placedChest = blackboard ? (blackboard.getFurniture('chest') || blackboard.getNearestChest(agent.position)) : null;
    const placedMineralChest = blackboard ? blackboard.getNearestChest(agent.position, 'minerals') : null;

    if (!placedChest) {
      if (hasChestInInv) {
        if (blackboard) {
          blackboard.registerChest({
            x: Math.round(agent.position.x),
            y: Math.round(agent.position.y),
            z: Math.round(agent.position.z + 1),
            category: 'general',
            registeredBy: bot.username
          });
        }
        return {
          goal: 'place storage chest furniture',
          action: 'place_block',
          arguments: { item: 'chest', dx: 0, dy: 0, dz: 1 },
          reason_summary: 'Placing shared storage chest furniture for team supplies.',
          expected_outcome: 'storage chest positioned',
          risk: 'low',
          confidence: 0.95
        };
      }
      if (planksCount >= 8) {
        return {
          goal: 'craft storage chest furniture',
          action: 'craft_item',
          arguments: { item: 'chest', count: 1 },
          reason_summary: 'Crafting chest furniture for shared swarm storage.',
          expected_outcome: 'inventory contains chest',
          risk: 'low',
          confidence: 0.95
        };
      }
      if (logsCount >= 2) {
        return {
          goal: 'craft planks for chest',
          action: 'craft_item',
          arguments: { item: 'planks', count: 2 },
          reason_summary: 'Converting logs into planks to craft shared chest furniture.',
          expected_outcome: 'inventory contains planks',
          risk: 'low',
          confidence: 0.9
        };
      }
    } else if (!placedMineralChest && (hasChestInInv || planksCount >= 8)) {
      // Place dedicated mineral chest for Miner to store mined ores and armory materials
      if (hasChestInInv) {
        if (blackboard) {
          blackboard.registerChest({
            x: Math.round(agent.position.x + 1),
            y: Math.round(agent.position.y),
            z: Math.round(agent.position.z + 1),
            category: 'minerals',
            registeredBy: bot.username
          });
        }
        return {
          goal: 'place mineral storage chest',
          action: 'place_block',
          arguments: { item: 'chest', category: 'minerals', dx: 1, dy: 0, dz: 1 },
          reason_summary: 'Placing dedicated mineral chest for Miner to store mined ores for weapons, shield, and armor.',
          expected_outcome: 'mineral chest placed',
          risk: 'low',
          confidence: 0.95
        };
      }
      return {
        goal: 'craft mineral storage chest furniture',
        action: 'craft_item',
        arguments: { item: 'chest', count: 1 },
        reason_summary: 'Crafting chest furniture dedicated to minerals and armory supplies.',
        expected_outcome: 'inventory contains chest',
        risk: 'low',
        confidence: 0.95
      };
    }

    // 4. FURNITURE: Furnace
    const placedFurnace = blackboard ? blackboard.getFurniture('furnace') : null;
    if (!placedFurnace) {
      if (hasFurnaceInInv) {
        return {
          goal: 'place furnace furniture',
          action: 'place_block',
          arguments: { item: 'furnace', dx: 1, dy: 0, dz: 0 },
          reason_summary: 'Placing stone furnace furniture for food cooking and ore smelting.',
          expected_outcome: 'furnace furniture positioned',
          risk: 'low',
          confidence: 0.95
        };
      }
      if (cobbleCount >= 8) {
        return {
          goal: 'craft furnace furniture',
          action: 'craft_item',
          arguments: { item: 'furnace', count: 1 },
          reason_summary: 'Crafting furnace furniture using gathered cobblestone.',
          expected_outcome: 'inventory contains furnace',
          risk: 'low',
          confidence: 0.95
        };
      }
    }

    // 5. WEAPONS, SHIELD, AND ARMOR CRAFTING AT WORKBENCH
    const ironIngotsCount = (inv || []).filter(i => i.name === 'iron_ingot' || i.name === 'iron').reduce((s, i) => s + (i.count || 1), 0);
    const leatherCount = this._countItem(inv, 'leather');
    const sticksCount = this._countItem(inv, 'stick');
    const hasShield = inv.some(i => i.name.includes('shield'));
    const hasSword = inv.some(i => i.name.includes('sword'));
    const hasArmor = inv.some(i => i.name.includes('chestplate') || i.name.includes('helmet'));

    // Craft Shield: 1 iron ingot + 6 planks at workbench (requires no sticks)
    if (!hasShield && ironIngotsCount >= 1 && planksCount >= 6) {
      return {
        goal: 'learn and craft shield at workbench',
        action: 'craft_item',
        arguments: { item: 'shield', count: 1 },
        reason_summary: 'Learning shield crafting recipe at crafting table using iron ingot and planks for team defense.',
        expected_outcome: 'shield crafted into inventory',
        risk: 'low',
        confidence: 0.96
      };
    }

    // Sticks for crafting weapons
    if (!hasSword && sticksCount === 0 && planksCount >= 2 && (ironIngotsCount >= 2 || cobbleCount >= 2)) {
      return {
        goal: 'craft sticks for weapons and tools',
        action: 'craft_item',
        arguments: { item: 'stick', count: 1 },
        reason_summary: 'Crafting sticks from planks to assemble weapons and tools at crafting table.',
        expected_outcome: 'inventory contains sticks',
        risk: 'low',
        confidence: 0.95
      };
    }

    // Craft Iron Sword: 2 iron ingots + 1 stick at workbench
    if (!hasSword && ironIngotsCount >= 2 && sticksCount >= 1) {
      return {
        goal: 'learn and craft iron sword at workbench',
        action: 'craft_item',
        arguments: { item: 'iron_sword', count: 1 },
        reason_summary: 'Forging iron sword weapon at crafting table using mined iron for team guards.',
        expected_outcome: 'iron sword crafted into inventory',
        risk: 'low',
        confidence: 0.95
      };
    }

    // Craft Stone Sword: 2 cobblestone + 1 stick at workbench
    if (!hasSword && cobbleCount >= 2 && sticksCount >= 1) {
      return {
        goal: 'learn and craft stone sword at workbench',
        action: 'craft_item',
        arguments: { item: 'stone_sword', count: 1 },
        reason_summary: 'Crafting stone sword weapon at crafting table using mined cobblestone from Miner.',
        expected_outcome: 'stone sword crafted into inventory',
        risk: 'low',
        confidence: 0.94
      };
    }

    // Craft Iron Armor: 8 iron ingots at workbench
    if (!hasArmor && ironIngotsCount >= 8) {
      return {
        goal: 'learn and craft iron armor at workbench',
        action: 'craft_item',
        arguments: { item: 'iron_chestplate', count: 1 },
        reason_summary: 'Forging iron chestplate armor at crafting table using mined iron to protect swarm.',
        expected_outcome: 'iron chestplate armor crafted into inventory',
        risk: 'low',
        confidence: 0.95
      };
    }

    // Craft Leather Armor: 8 leather at workbench
    if (!hasArmor && leatherCount >= 8) {
      return {
        goal: 'learn and craft leather armor at workbench',
        action: 'craft_item',
        arguments: { item: 'leather_chestplate', count: 1 },
        reason_summary: 'Tailoring leather chestplate armor at crafting table using leather gathered by Explorer.',
        expected_outcome: 'leather chestplate crafted into inventory',
        risk: 'low',
        confidence: 0.93
      };
    }

    // 6. FURNITURE: Torches (Illumination to prevent mob spawns)
    const placedTorches = blackboard ? blackboard.getFurniture('torch') : null;
    if (!placedTorches && coalCount > 0) {
      if (hasTorchesInInv) {
        return {
          goal: 'place torch furniture on shelter wall',
          action: 'place_block',
          arguments: { item: 'torch', dx: 0, dy: 1, dz: 0 },
          reason_summary: 'Placing torch furniture to illuminate base and prevent mob spawns.',
          expected_outcome: 'torch placed and base illuminated',
          risk: 'low',
          confidence: 0.95
        };
      }
      return {
        goal: 'craft torch furniture',
        action: 'craft_item',
        arguments: { item: 'torch', count: 1 },
        reason_summary: 'Crafting torches with coal and sticks to illuminate base shelter.',
        expected_outcome: 'inventory contains torches',
        risk: 'low',
        confidence: 0.9
      };
    }

    // 7. FURNITURE: Bed (Skipping night safely)
    const placedBed = blackboard ? blackboard.getFurniture('bed') : null;
    if (!placedBed && woolCount >= 3 && planksCount >= 3) {
      if (hasBedInInv) {
        return {
          goal: 'place bed furniture inside shelter',
          action: 'place_block',
          arguments: { item: 'bed', dx: 0, dy: 0, dz: 2 },
          reason_summary: 'Placing bed furniture inside shelter for night skipping.',
          expected_outcome: 'bed positioned in safe room',
          risk: 'low',
          confidence: 0.95
        };
      }
      return {
        goal: 'craft bed furniture',
        action: 'craft_item',
        arguments: { item: 'bed', count: 1 },
        reason_summary: 'Crafting bed furniture with wool collected by Explorer and planks.',
        expected_outcome: 'inventory contains bed',
        risk: 'low',
        confidence: 0.95
      };
    }

    // 8. BUILD FARM PLOT: Establish agricultural zone for Farmer
    const existingFarm = blackboard ? blackboard.getNearestFarm(agent.position) : null;
    if (!existingFarm && blackboard) {
      blackboard.registerFarm({
        x: Math.round(agent.position.x + 3),
        y: Math.round(agent.position.y),
        z: Math.round(agent.position.z + 3),
        crop: 'wheat',
        registeredBy: bot.username
      });
      return {
        goal: 'build farm plot for agriculture',
        action: 'farm_crop',
        arguments: { max_distance: 12 },
        reason_summary: 'Establishing farm plot and tilling soil near base camp for sustainable crop production.',
        expected_outcome: 'farm plot established on shared memory',
        risk: 'low',
        confidence: 0.92
      };
    }

    // 9. Shelter Wall Expansion / Reinforcement
    if (dirtCount + cobbleCount >= 4) {
      return {
        goal: 'reinforce shelter walls',
        action: 'place_block',
        arguments: { block: dirtCount >= 2 ? 'dirt' : 'cobblestone', dx: -1, dy: 0, dz: 0 },
        reason_summary: 'Fortifying perimeter walls of the team shelter safe room.',
        expected_outcome: 'shelter walls reinforced',
        risk: 'low',
        confidence: 0.9
      };
    }

    // 8. Request building supplies if low
    if (logsCount === 0 && planksCount < 4) {
      const activeReq = blackboard ? blackboard.getActiveResourceRequests().find(r => r.botName === bot.username && r.resource === 'wood') : null;
      if (!activeReq && messageBus && blackboard) {
        blackboard.postResourceRequest({
          botName: bot.username,
          resource: 'wood',
          count: 3,
          position: observation.agent.position
        });
        messageBus.requestResource(bot, 'wood', 3, observation.agent.position);
      }
      return {
        goal: 'gather building dirt',
        action: 'collect_resource',
        arguments: { resource: 'dirt' },
        reason_summary: 'Gathering dirt blocks while awaiting wood supplies.',
        expected_outcome: 'inventory contains dirt',
        risk: 'low',
        confidence: 0.8
      };
    }

    return {
      goal: 'inspect building materials',
      action: 'inspect_inventory',
      arguments: {},
      reason_summary: 'Auditing available supplies for next construction project.',
      expected_outcome: 'inventory refreshed',
      risk: 'low',
      confidence: 0.85
    };
  }

  _planFarmer({ bot, observation, blackboard, messageBus }) {
    const inv = observation.inventory || [];
    const agent = observation.agent;
    const cropCount = this._countItem(inv, 'wheat') + this._countItem(inv, 'carrot') + this._countItem(inv, 'potato') + this._countItem(inv, 'bread') + this._countItem(inv, 'sweet_berries');
    const logsCount = this._countItem(inv, 'log') + this._countItem(inv, 'wood');

    // Farmer Priority 1: Check active resource requests from teammates
    if (blackboard) {
      const requests = blackboard.getActiveResourceRequests();
      if (requests.length > 0) {
        const req = requests[0];
        const hasRequestedItem = inv.some(i => i.name.includes(req.resource));

        if (hasRequestedItem) {
          const teammate = blackboard.getMember(req.botName);
          if (teammate && teammate.position) {
            const dist = Math.hypot(agent.position.x - teammate.position.x, agent.position.z - teammate.position.z);
            if (dist <= 3.5) {
              blackboard.fulfillResourceRequest(req.id, bot.username);
              const matchingItem = inv.find(i => i.name.includes(req.resource));
              return {
                goal: `share ${req.resource} with teammate ${req.botName}`,
                action: 'drop_item',
                arguments: { item: matchingItem.name, count: req.count, teammate: req.botName },
                reason_summary: `Dropping ${req.count}x ${matchingItem.name} for teammate ${req.botName}.`,
                expected_outcome: 'items dropped for teammate',
                risk: 'low',
                confidence: 1.0
              };
            } else {
              return {
                goal: `deliver ${req.resource} to teammate ${req.botName}`,
                action: 'navigate_to',
                arguments: { x: teammate.position.x, y: teammate.position.y, z: teammate.position.z, range: 2.5 },
                reason_summary: `Navigating to teammate ${req.botName} to deliver requested ${req.resource}.`,
                expected_outcome: 'reaches teammate to hand off items',
                risk: 'low',
                confidence: 0.95
              };
            }
          }
        }
      }
    }

    // Farmer Priority 1.5: RESPOND TO FOOD REQUESTS from hungry teammates
    if (blackboard && typeof blackboard.getActiveFoodRequests === 'function') {
      const foodReqs = blackboard.getActiveFoodRequests();
      const criticalReq = foodReqs.find(r => r.urgency === 'critical') || foodReqs[0];
      if (criticalReq && criticalReq.botName !== bot.username) {
        // Check if we have food to deliver
        const FARMER_FOOD = ['wheat', 'bread', 'carrot', 'potato', 'baked_potato',
          'beetroot', 'sweet_berries', 'apple', 'melon_slice'];
        const foodInInventory = inv.filter(i => FARMER_FOOD.includes(i.name));
        const totalFood = foodInInventory.reduce((sum, i) => sum + (i.count || 1), 0);

        if (totalFood >= 3 && criticalReq.position) {
          // Deliver food to teammate
          blackboard.claimFoodRequest(criticalReq.id, bot.username);
          return {
            goal: `deliver farm food to hungry ${criticalReq.botName}`,
            action: 'navigate_to',
            arguments: { x: criticalReq.position.x, y: criticalReq.position.y, z: criticalReq.position.z, range: 2.0 },
            reason_summary: `Teammate ${criticalReq.botName} is hungry (${criticalReq.urgency}). Delivering ${totalFood} farm rations.`,
            expected_outcome: 'reaches hungry teammate to share farm food',
            risk: 'low',
            confidence: 0.9
          };
        } else if (totalFood < 3) {
          // Prioritize farming to get food for the request — accelerate harvest
          return {
            goal: 'emergency farm harvest for hungry teammate',
            action: 'farm_crop',
            arguments: { max_distance: 16 },
            reason_summary: `Teammate ${criticalReq.botName} needs food urgently. Prioritizing immediate crop harvest.`,
            expected_outcome: 'harvests food to fulfill teammate food request',
            risk: 'low',
            confidence: 0.85
          };
        }
      }
    }

    // Farmer Priority 2: Deposit surplus harvest in food chest
    if (blackboard && cropCount >= 5) {
      const chest = blackboard.getNearestChest(agent.position, 'food');
      if (chest && chest.distance <= 8.0) {
        return {
          goal: 'deposit harvested crops in shared food chest',
          action: 'store_in_chest',
          arguments: { category: 'food', x: chest.x, y: chest.y, z: chest.z },
          reason_summary: 'Storing surplus harvested crops into the dedicated food storage chest.',
          expected_outcome: 'crops deposited in food chest',
          risk: 'low',
          confidence: 0.95
        };
      }
    }

    // Farmer Priority 3: Cultivate farm crops (harvest mature & replant)
    const existingFarm = blackboard ? blackboard.getNearestFarm(agent.position) : null;
    if (!existingFarm && blackboard) {
      blackboard.registerFarm({
        x: Math.round(agent.position.x + 2),
        y: Math.round(agent.position.y),
        z: Math.round(agent.position.z + 2),
        crop: 'wheat',
        registeredBy: bot.username
      });
    }

    // If near farm or mature crops available, execute farm_crop
    return {
      goal: 'farm crops and replant seeds',
      action: 'farm_crop',
      arguments: { max_distance: 12 },
      reason_summary: 'Tending crops: harvesting mature wheat, carrots, and potatoes, and replanting seeds for next cycle.',
      expected_outcome: 'harvests mature crops and replants farmland',
      risk: 'low',
      confidence: 0.9
    };
  }

  _planGatherer(params) {
    // Backwards-compatible alias for farmer
    return this._planFarmer(params);
  }

  _planExplorer({ bot, observation, blackboard, messageBus }) {
    const nearbyRes = observation.nearby_resources || [];
    const threats = observation.nearby_threats || [];
    const agent = observation.agent;
    const inv = observation.inventory || [];

    // Explorer Priority 1: Threat evasion & alert to Guard
    if (threats.length > 0) {
      const threat = threats[0];
      if (blackboard) {
        blackboard.registerThreat({
          mob: threat.name,
          x: threat.position?.x || agent.position.x,
          y: threat.position?.y || agent.position.y,
          z: threat.position?.z || agent.position.z,
          reportedBy: bot.username
        });
      }
      if (messageBus) {
        messageBus.alertThreatSpotted(bot, threat.name, threat.position || agent.position);
      }

      // Retreat toward Guard or shelter
      if (blackboard) {
        const ally = blackboard.getNearestTeammate(agent.position, bot.username);
        if (ally) {
          return {
            goal: 'retreat towards ally Guard',
            action: 'navigate_to',
            arguments: { x: ally.position.x, y: ally.position.y, z: ally.position.z, range: 3.0 },
            reason_summary: `Threat ${threat.name} detected; falling back to ally ${ally.name}.`,
            expected_outcome: 'safely groups with ally',
            risk: 'medium',
            confidence: 0.95
          };
        }
      }
    }

    // Explorer Priority 1.5: RESPOND TO FOOD REQUESTS from hungry teammates
    if (blackboard && typeof blackboard.getActiveFoodRequests === 'function') {
      const foodReqs = blackboard.getActiveFoodRequests();
      const criticalReq = foodReqs.find(r => r.urgency === 'critical') || foodReqs[0];
      if (criticalReq && criticalReq.botName !== bot.username) {
        // Check if we have food to deliver
        const FOOD_ITEMS = ['cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton',
          'beef', 'porkchop', 'chicken', 'mutton', 'bread', 'apple', 'sweet_berries'];
        const foodInInventory = inv.filter(i => FOOD_ITEMS.includes(i.name));
        const totalFood = foodInInventory.reduce((sum, i) => sum + (i.count || 1), 0);

        if (totalFood >= 2 && criticalReq.position) {
          // Claim the food request and deliver
          blackboard.claimFoodRequest(criticalReq.id, bot.username);
          return {
            goal: `deliver food to hungry ${criticalReq.botName}`,
            action: 'navigate_to',
            arguments: { x: criticalReq.position.x, y: criticalReq.position.y, z: criticalReq.position.z, range: 2.0 },
            reason_summary: `Teammate ${criticalReq.botName} needs food (${criticalReq.urgency}). Delivering ${totalFood} rations.`,
            expected_outcome: 'reaches hungry teammate to share food',
            risk: 'low',
            confidence: 0.9
          };
        } else if (totalFood < 2) {
          // We need to hunt first to fulfill the request — fall through to hunting priority
        }
      }
    }

    // Explorer Priority 2: HUNTING ANIMALS for food (creature-aware)
    const HUNTABLE_ANIMALS = ['cow', 'pig', 'chicken', 'sheep', 'rabbit', 'cod', 'salmon'];
    let huntTarget = null;
    let bestDistance = 25.0;
    if (bot.entities) {
      for (const id in bot.entities) {
        const ent = bot.entities[id];
        if (ent && HUNTABLE_ANIMALS.includes(ent.name) && ent.position && bot.entity?.position) {
          const d = Math.hypot(ent.position.x - bot.entity.position.x, ent.position.z - bot.entity.position.z);
          if (d <= bestDistance) {
            bestDistance = d;
            huntTarget = { ...ent, distance: d };
          }
        }
      }
    }

    if (huntTarget) {
      if (blackboard) {
        blackboard.registerAnimalHerd({
          type: huntTarget.name,
          x: huntTarget.position.x,
          y: huntTarget.position.y,
          z: huntTarget.position.z,
          spottedBy: bot.username
        });
        // Record creature encounter for learning
        if (typeof blackboard.recordCreatureEncounter === 'function') {
          blackboard.recordCreatureEncounter({
            creature: huntTarget.name,
            x: huntTarget.position.x,
            y: huntTarget.position.y,
            z: huntTarget.position.z,
            killed: false,
            reportedBy: bot.username
          });
        }
      }
      return {
        goal: `hunt wild ${huntTarget.name} for food rations`,
        action: 'attack_target',
        arguments: { mob: huntTarget.name },
        reason_summary: `Hunting nearby ${huntTarget.name} at ${Math.round(huntTarget.distance)}m to harvest meat for team.`,
        expected_outcome: 'animal hunted and meat collected',
        risk: 'low',
        confidence: 0.95
      };
    }

    // Explorer Priority 3: GATHER WILD FOOD (berries, apples, mushrooms)
    const wildFoodCount = this._countItem(inv, 'beef') + this._countItem(inv, 'porkchop') + this._countItem(inv, 'mutton') + this._countItem(inv, 'chicken') + this._countItem(inv, 'sweet_berries');
    if (wildFoodCount < 4) {
      const berryRes = nearbyRes.find(r => r.name === 'sweet_berries' || r.name === 'berry_bush');
      if (berryRes) {
        if (blackboard) {
          blackboard.registerFoodSource({
            type: 'sweet_berries',
            x: berryRes.position?.x || agent.position.x,
            y: berryRes.position?.y || agent.position.y,
            z: berryRes.position?.z || agent.position.z,
            discoveredBy: bot.username
          });
        }
        return {
          goal: 'gather sweet berries for swarm rations',
          action: 'collect_resource',
          arguments: { resource: 'sweet_berries' },
          reason_summary: 'Foraging sweet berry bush to replenish team food reserves.',
          expected_outcome: 'food supplies replenished',
          risk: 'low',
          confidence: 0.9
        };
      }
    }

    // Explorer Priority 4: FOOD RETURN to base food chest
    if (wildFoodCount >= 5 && blackboard) {
      const chest = blackboard.getNearestChest(agent.position, 'food');
      if (chest && chest.distance <= 10.0) {
        return {
          goal: 'deposit hunted food in shared food chest',
          action: 'store_in_chest',
          arguments: { category: 'food', x: chest.x, y: chest.y, z: chest.z },
          reason_summary: 'Delivering hunted meat and wild food rations into team food storage chest.',
          expected_outcome: 'food stored in food chest',
          risk: 'low',
          confidence: 0.9
        };
      }
    }

    // Explorer Priority 5: ARMORY/MINERAL RETURN (Leather, wool, feathers, bones for armor and beds)
    const armoryResCount = this._countItem(inv, 'leather') + this._countItem(inv, 'wool') + this._countItem(inv, 'feather') + this._countItem(inv, 'bone');
    if (armoryResCount >= 3 && blackboard) {
      const chest = blackboard.getNearestChest(agent.position, 'minerals') || blackboard.getNearestChest(agent.position, 'armory');
      if (chest && chest.distance <= 10.0) {
        return {
          goal: 'deposit hunting craft materials in armory chest',
          action: 'store_in_chest',
          arguments: { category: 'armory', x: chest.x, y: chest.y, z: chest.z },
          reason_summary: 'Depositing leather, wool, and crafting drops into dedicated armory chest for weapons, shield, and armor crafting.',
          expected_outcome: 'armory supplies stored in separate chest',
          risk: 'low',
          confidence: 0.9
        };
      }
    }

    // Explorer Priority 5: DRAW MAP & MARK WAYPOINTS
    if (nearbyRes.length > 0 && blackboard) {
      for (const res of nearbyRes) {
        blackboard.registerResource({
          type: res.name,
          x: res.position?.x || agent.position.x,
          y: res.position?.y || agent.position.y,
          z: res.position?.z || agent.position.z,
          discoveredBy: bot.username
        });

        // Mark waypoint on shared memory if ore or special landmark
        if (['coal_ore', 'iron_ore', 'copper_ore', 'water'].includes(res.name)) {
          blackboard.registerWaypoint({
            name: `${res.name.replace('_', ' ').toUpperCase()} Deposit`,
            type: 'resource_vein',
            x: res.position?.x || agent.position.x,
            y: res.position?.y || agent.position.y,
            z: res.position?.z || agent.position.z,
            tags: [res.name],
            markedBy: bot.username
          });
        }
      }
    }

    // Scout outward waypoint to expand map
    const angle = (Date.now() / 8000) % (2 * Math.PI);
    const targetX = Math.round(agent.position.x + Math.cos(angle) * 16);
    const targetZ = Math.round(agent.position.z + Math.sin(angle) * 16);

    if (blackboard && Math.random() < 0.25) {
      blackboard.registerWaypoint({
        name: `Scout Waypoint (${targetX}, ${targetZ})`,
        type: 'scout_marker',
        x: targetX,
        y: Math.round(agent.position.y),
        z: targetZ,
        tags: ['frontier', 'explored'],
        markedBy: bot.username
      });
    }

    return {
      goal: 'draw terrain map and scout frontier',
      action: 'navigate_to',
      arguments: { x: targetX, z: targetZ, range: 2.0 },
      reason_summary: 'Reconnaissance mapping: surveying surrounding terrain, marking waypoints, and searching for wild game.',
      expected_outcome: 'marks map waypoint and expands team radar',
      risk: 'low',
      confidence: 0.85
    };
  }

  _planMiner({ bot, observation, blackboard, messageBus }) {
    const inv = observation.inventory || [];
    const agent = observation.agent;
    const nearbyRes = observation.nearby_resources || [];

    const cobbleCount = (inv || []).filter(i => i.name.includes('cobble') || i.name === 'stone').reduce((s, i) => s + (i.count || 1), 0);
    const coalCount = (inv || []).filter(i => i.name.includes('coal')).reduce((s, i) => s + (i.count || 1), 0);
    const ironCount = (inv || []).filter(i => i.name.includes('iron')).reduce((s, i) => s + (i.count || 1), 0);
    const copperCount = (inv || []).filter(i => i.name.includes('copper')).reduce((s, i) => s + (i.count || 1), 0);
    const totalMinerals = cobbleCount + coalCount + ironCount + copperCount;

    const hasPickaxe = inv.some(i => i.name.includes('pickaxe'));
    const woodCount = this._countItem(inv, 'log') + this._countItem(inv, 'wood') + this._countItem(inv, 'planks');

    // Miner Priority 1: Pickaxe Check (Tool needed to mine stone and ores)
    if (!hasPickaxe) {
      if (cobbleCount >= 3 && this._countItem(inv, 'stick') >= 2) {
        return {
          goal: 'craft stone pickaxe for mining',
          action: 'craft_item',
          arguments: { item: 'stone_pickaxe', count: 1 },
          reason_summary: 'Crafting stone pickaxe at crafting table for subterranean mining.',
          expected_outcome: 'inventory contains stone pickaxe',
          risk: 'low',
          confidence: 0.95
        };
      }
      if (woodCount >= 3) {
        return {
          goal: 'craft wooden pickaxe for mining',
          action: 'craft_item',
          arguments: { item: 'wooden_pickaxe', count: 1 },
          reason_summary: 'Crafting wooden pickaxe to begin mining stone and ore deposits.',
          expected_outcome: 'inventory contains wooden pickaxe',
          risk: 'low',
          confidence: 0.95
        };
      }
      return {
        goal: 'harvest wood for mining pickaxe',
        action: 'collect_resource',
        arguments: { resource: 'oak_log' },
        reason_summary: 'Harvesting tree wood to craft pickaxes for subterranean mining operations.',
        expected_outcome: 'wood collected for tool crafting',
        risk: 'low',
        confidence: 0.9
      };
    }

    // Miner Priority 2: Deposit Mined Minerals in Dedicated Mineral Chest
    if (blackboard && totalMinerals >= 5) {
      const chest = blackboard.getNearestChest(agent.position, 'minerals');
      if (chest) {
        if (chest.distance <= 6.0) {
          return {
            goal: 'deposit mined minerals in mineral chest',
            action: 'store_in_chest',
            arguments: { category: 'minerals', x: chest.x, y: chest.y, z: chest.z },
            reason_summary: `Depositing ${totalMinerals}x mined minerals (cobblestone, coal, iron) into dedicated mineral chest for weapons, shield, and armor crafting.`,
            expected_outcome: 'minerals safely stored in team armory/mineral chest',
            risk: 'low',
            confidence: 0.98
          };
        } else {
          return {
            goal: 'navigate to mineral storage chest',
            action: 'navigate_to',
            arguments: { x: chest.x, y: chest.y, z: chest.z, range: 3.0 },
            reason_summary: 'Returning to base to deliver mined minerals into the dedicated mineral storage chest.',
            expected_outcome: 'arrives at mineral chest location',
            risk: 'low',
            confidence: 0.92
          };
        }
      } else {
        // If no mineral chest exists, check if miner has a chest in inventory
        const hasChestInInv = inv.some(i => i.name === 'chest');
        if (hasChestInInv) {
          blackboard.registerChest({
            x: Math.round(agent.position.x + 1),
            y: Math.round(agent.position.y),
            z: Math.round(agent.position.z),
            category: 'minerals',
            registeredBy: bot.username
          });
          return {
            goal: 'place dedicated mineral chest',
            action: 'place_block',
            arguments: { item: 'chest', category: 'minerals', dx: 1, dy: 0, dz: 0 },
            reason_summary: 'Setting up dedicated mineral storage chest for weapons, shield, and armor supplies.',
            expected_outcome: 'mineral storage chest placed and registered',
            risk: 'low',
            confidence: 0.95
          };
        }
      }
    }

    // Miner Priority 3: Mine Ore Veins (Iron, Coal, Copper)
    const ironVein = blackboard ? blackboard.getNearestResource('iron_ore', agent.position) : null;
    const coalVein = blackboard ? blackboard.getNearestResource('coal_ore', agent.position) : null;
    const copperVein = blackboard ? blackboard.getNearestResource('copper_ore', agent.position) : null;
    const targetVein = ironVein || coalVein || copperVein;

    if (targetVein && targetVein.distance <= 16.0) {
      return {
        goal: `mine ${targetVein.type} vein at waypoint`,
        action: 'collect_resource',
        arguments: { resource: targetVein.type },
        reason_summary: `Mining high-priority ${targetVein.type} at mapped coordinates (${targetVein.x}, ${targetVein.z}) for weapon and armor forging.`,
        expected_outcome: `extracts ${targetVein.type}`,
        risk: 'low',
        confidence: 0.95
      };
    }

    // Check nearby observable resources
    const nearbyOre = nearbyRes.find(r => r.name.includes('iron') || r.name.includes('coal') || r.name.includes('copper'));
    if (nearbyOre) {
      if (blackboard) {
        blackboard.registerResource({
          type: nearbyOre.name,
          x: nearbyOre.position?.x || agent.position.x,
          y: nearbyOre.position?.y || agent.position.y,
          z: nearbyOre.position?.z || agent.position.z,
          discoveredBy: bot.username
        });
        blackboard.registerWaypoint({
          name: `${nearbyOre.name.toUpperCase()} Vein`,
          type: 'mineral_vein',
          x: nearbyOre.position?.x || agent.position.x,
          y: nearbyOre.position?.y || agent.position.y,
          z: nearbyOre.position?.z || agent.position.z,
          tags: ['mineral', nearbyOre.name],
          markedBy: bot.username
        });
      }
      return {
        goal: `mine nearby ${nearbyOre.name}`,
        action: 'collect_resource',
        arguments: { resource: nearbyOre.name },
        reason_summary: `Extracting ${nearbyOre.name} deposit to supply team forge.`,
        expected_outcome: 'ore added to inventory',
        risk: 'low',
        confidence: 0.95
      };
    }

    // Miner Priority 4: Mine Cobblestone & Stone
    return {
      goal: 'mine stone and cobblestone',
      action: 'collect_resource',
      arguments: { resource: 'stone' },
      reason_summary: 'Mining stone layers to collect cobblestone for base construction, stone weapons, and furnace crafting.',
      expected_outcome: 'cobblestone extracted into inventory',
      risk: 'low',
      confidence: 0.9
    };
  }

  _countItem(inv, nameSubstring) {
    if (!Array.isArray(inv)) return 0;
    let count = 0;
    for (const item of inv) {
      if (item && item.name && item.name.includes(nameSubstring)) {
        count += (item.count || 1);
      }
    }
    return count;
  }
}

export const defaultSwarmRolePlanner = new SwarmRolePlanner();
export default defaultSwarmRolePlanner;
