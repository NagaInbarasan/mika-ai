/**
 * Adaptive Thinking Engine for MIKA.
 * Evaluates completed task memories to decide whether to:
 * 1. Replicate a proven, validated strategy (fast, reliable execution).
 * 2. Improve upon it using cognitive reasoning (tool upgrades, batching, LLM insight).
 */

export class AdaptiveThinkingEngine {
  constructor(options = {}) {
    this.toolHierarchy = {
      pickaxe: ['netherite_pickaxe', 'diamond_pickaxe', 'iron_pickaxe', 'stone_pickaxe', 'wooden_pickaxe', 'golden_pickaxe'],
      axe: ['netherite_axe', 'diamond_axe', 'iron_axe', 'stone_axe', 'wooden_axe', 'golden_axe'],
      sword: ['netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'wooden_sword', 'golden_sword']
    };
  }

  /**
   * Evaluates memory of past task completions to formulate an execution plan.
   *
   * @param {Object} params
   * @param {Object} params.bot - Live Mineflayer bot instance or mock
   * @param {string} params.goalId - Active survival goal
   * @param {Object} params.observation - Current world observation
   * @param {Object} params.memoryStore - PersistentMemoryStore instance
   * @param {Object} [params.planner=null] - Optional HighLevelPlanner (Qwen LLM)
   * @returns {Promise<{ mode: string, strategy: Object|null, proposedAction: string|null, proposedArgs: Object|null, rationale: string }>}
   */
  async evaluateStrategy({ bot, goalId, observation, memoryStore, planner = null }) {
    if (!memoryStore || typeof memoryStore.getBestStrategy !== 'function') {
      return {
        mode: 'first_exploration',
        strategy: null,
        proposedAction: null,
        proposedArgs: null,
        rationale: 'Memory store not initialized. Using baseline exploration.'
      };
    }

    const pastStrategy = memoryStore.getBestStrategy(goalId, observation);
    if (!pastStrategy) {
      return {
        mode: 'first_exploration',
        strategy: null,
        proposedAction: null,
        proposedArgs: null,
        rationale: `No previous completion memory for '${goalId}'. Using first-principles discovery.`
      };
    }

    // A past strategy exists! Now determine: can we improve upon it with thinking ability?
    const inventory = observation?.inventory || [];
    const equipment = observation?.equipment || {};
    const heldTool = equipment?.mainhand?.name || null;

    // -------------------------------------------------------------
    // Thinking Pathway 1: Tool Upgrade Optimization
    // -------------------------------------------------------------
    if (goalId === 'GATHER_WOOD_LOGS') {
      const bestAxe = this.findBestItemInInventory(inventory, 'axe');
      const pastTool = pastStrategy.optimal_tool;

      // If we have an axe now that is superior to what was used in past memory
      if (bestAxe && (!pastTool || this.isItemSuperior(bestAxe, pastTool, 'axe'))) {
        return {
          mode: 'improved_thinking',
          strategy: pastStrategy,
          proposedAction: 'collect_resource',
          proposedArgs: { resource: 'wood', count: pastStrategy.args?.count || 3, preferred_tool: bestAxe },
          rationale: `Cognitive improvement: equipped ${bestAxe} (superior to past tool '${pastTool || 'unarmed'}') for faster wood harvesting.`
        };
      }
    }

    if (goalId === 'MINE_STONE') {
      const bestPick = this.findBestItemInInventory(inventory, 'pickaxe');
      const pastTool = pastStrategy.optimal_tool;

      if (bestPick && pastTool && this.isItemSuperior(bestPick, pastTool, 'pickaxe')) {
        return {
          mode: 'improved_thinking',
          strategy: pastStrategy,
          proposedAction: 'collect_resource',
          proposedArgs: { resource: 'stone', count: pastStrategy.args?.count || 3, preferred_tool: bestPick },
          rationale: `Cognitive improvement: upgraded to ${bestPick} (superior to previous '${pastTool}') for cobblestone collection.`
        };
      }
    }

    // -------------------------------------------------------------
    // Thinking Pathway 2: Batching & Recipe Efficiency
    // -------------------------------------------------------------
    if (goalId === 'CRAFT_PLANKS') {
      const logsItem = inventory.find(i => i.name && i.name.includes('_log'));
      const logCount = logsItem ? logsItem.count : 0;
      // If we have abundant logs and previously only crafted 1 set, batch craft to save cycles
      if (logCount >= 3 && (pastStrategy.args?.count || 1) < 2) {
        return {
          mode: 'improved_thinking',
          strategy: pastStrategy,
          proposedAction: 'craft_item',
          proposedArgs: { item: 'planks', count: Math.min(logCount, 4) },
          rationale: `Cognitive improvement: batch crafting ${Math.min(logCount, 4)} plank sets from ${logCount} logs to reduce survival overhead.`
        };
      }
    }

    if (goalId === 'CRAFT_STICKS') {
      const planksCount = inventory.reduce((acc, i) => i.name && i.name.includes('planks') ? acc + i.count : acc, 0);
      if (planksCount >= 6 && (pastStrategy.args?.count || 1) < 2) {
        return {
          mode: 'improved_thinking',
          strategy: pastStrategy,
          proposedAction: 'craft_item',
          proposedArgs: { item: 'stick', count: 2 },
          rationale: `Cognitive improvement: batch crafting sticks (count 2) using ${planksCount} available planks.`
        };
      }
    }

    // -------------------------------------------------------------
    // Thinking Pathway 3: LLM / Qwen Reasoning Prompting
    // -------------------------------------------------------------
    if (planner && typeof planner.planNextStep === 'function') {
      try {
        const enrichedMemories = [
          {
            type: 'proven_successful_strategy',
            goal: goalId,
            action: pastStrategy.action,
            arguments: pastStrategy.args,
            best_duration_ms: pastStrategy.best_duration_ms,
            completions: pastStrategy.total_completions,
            confidence: pastStrategy.confidence
          }
        ];

        const llmPlan = await planner.planNextStep({
          observation,
          goal: `Accomplish ${goalId} either using proven method or improved method`,
          memories: enrichedMemories
        });

        if (llmPlan && llmPlan.success && llmPlan.decision) {
          const dec = llmPlan.decision;
          // Check if LLM proposed a novel or improved action
          const isDifferentAction = dec.action !== pastStrategy.action;
          const isDifferentArgs = JSON.stringify(dec.arguments || {}) !== JSON.stringify(pastStrategy.args || {});

          if (isDifferentAction || isDifferentArgs) {
            return {
              mode: 'improved_thinking_llm',
              strategy: pastStrategy,
              proposedAction: dec.action,
              proposedArgs: dec.arguments || {},
              rationale: `LLM Reasoning improvement: ${dec.reason_summary || 'Alternative strategy proposed by Qwen reasoner'}`
            };
          }
        }
      } catch (err) {
        // Fall back cleanly to proven memory
      }
    }

    // -------------------------------------------------------------
    // Default: Proven Memory Replication (Fast, Guaranteed Success)
    // -------------------------------------------------------------
    return {
      mode: 'proven_memory',
      strategy: pastStrategy,
      proposedAction: pastStrategy.action,
      proposedArgs: { ...pastStrategy.args },
      rationale: `Replicating proven strategy for '${goalId}' (Confidence: ${pastStrategy.confidence}, Best Duration: ${pastStrategy.best_duration_ms}ms, Successes: ${pastStrategy.total_completions}).`
    };
  }

  /**
   * Helper to locate the highest tier item of a tool category in inventory.
   */
  findBestItemInInventory(inventory = [], category = 'axe') {
    const ladder = this.toolHierarchy[category] || [];
    for (const toolName of ladder) {
      if (inventory.some(i => i.name === toolName && i.count > 0)) {
        return toolName;
      }
    }
    return null;
  }

  /**
   * Helper to compare if itemA is higher tier than itemB.
   */
  isItemSuperior(itemA, itemB, category) {
    if (!itemA) return false;
    if (!itemB) return true;
    const ladder = this.toolHierarchy[category] || [];
    const indexA = ladder.indexOf(itemA);
    const indexB = ladder.indexOf(itemB);
    if (indexA === -1) return false;
    if (indexB === -1) return true;
    return indexA < indexB; // Lower index = higher tier
  }
}

export const defaultAdaptiveThinking = new AdaptiveThinkingEngine();
export default defaultAdaptiveThinking;
