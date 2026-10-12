import {
  GOAL_DEFINITIONS,
  resolveGoalPlan,
  countAvailableBuildingBlocks,
  countWoodLogs,
  countPlanks,
  countTotalPickaxes,
  countEdibleFood,
  getItemCount
} from '../learning/goals.js';

/**
 * Goal Planner
 * Converts high-level objectives into tasks with prerequisites, priorities,
 * and completion conditions. Uses a dependency DAG rather than hardcoded scripts.
 */
export class GoalPlanner {
  constructor(definitions = GOAL_DEFINITIONS) {
    this.definitions = definitions;
  }

  /**
   * Resolves a high-level objective into an ordered execution plan of sub-tasks.
   * If prerequisites are missing, recursively decomposes until an actionable task is found.
   * Already satisfied tasks are pruned automatically.
   *
   * @param {string} highLevelGoal - e.g. 'CRAFT_WOODEN_PICKAXE', 'BUILD_EMERGENCY_SHELTER'
   * @param {Object} observation - Current world and inventory state
   * @returns {{
   *   targetGoal: string,
   *   isCompleted: boolean,
   *   prerequisitesSatisfied: boolean,
   *   missingPrerequisites: string[],
   *   plan: string[],
   *   nextImmediateTask: string|null,
   *   taskDetails: Object|null
   * }}
   */
  convertObjectiveToPlan(highLevelGoal, observation) {
    const goalDef = this.definitions[highLevelGoal];
    if (!goalDef) {
      return {
        targetGoal: highLevelGoal,
        isCompleted: false,
        prerequisitesSatisfied: false,
        missingPrerequisites: [`Unknown goal definition '${highLevelGoal}'`],
        plan: [],
        nextImmediateTask: null,
        taskDetails: null
      };
    }

    const completion = goalDef.isCompleted(observation);
    if (completion.completed) {
      return {
        targetGoal: highLevelGoal,
        isCompleted: true,
        completionReason: completion.reason,
        prerequisitesSatisfied: true,
        missingPrerequisites: [],
        plan: [],
        nextImmediateTask: null,
        taskDetails: goalDef
      };
    }

    const prereqCheck = goalDef.checkPrerequisites(observation);
    const plan = resolveGoalPlan(highLevelGoal, observation);
    const nextTask = plan[0] || null;

    return {
      targetGoal: highLevelGoal,
      isCompleted: false,
      prerequisitesSatisfied: prereqCheck.satisfied,
      missingPrerequisites: prereqCheck.missing || [],
      plan,
      nextImmediateTask: nextTask,
      taskDetails: nextTask ? this.definitions[nextTask] : null
    };
  }

  /**
   * Checks whether a task's prerequisites are currently met.
   * @param {string} goalId
   * @param {Object} observation
   * @returns {{ satisfied: boolean, missing: string[] }}
   */
  checkPrerequisites(goalId, observation) {
    const def = this.definitions[goalId];
    if (!def) return { satisfied: false, missing: [`Unknown goal: ${goalId}`] };
    return def.checkPrerequisites(observation);
  }

  /**
   * Checks whether a task's completion condition is fulfilled.
   * @param {string} goalId
   * @param {Object} observation
   * @returns {{ completed: boolean, reason: string }}
   */
  isCompleted(goalId, observation) {
    const def = this.definitions[goalId];
    if (!def) return { completed: false, reason: `Unknown goal: ${goalId}` };
    return def.isCompleted(observation);
  }

  /**
   * Returns metadata for all registered goals.
   * @returns {Array<{ id: string, name: string, category: string, priorityScore: number, dependencies: string[] }>}
   */
  listGoals() {
    return Object.values(this.definitions).map(d => ({
      id: d.id,
      name: d.name,
      category: d.category,
      priorityScore: d.priorityScore,
      dependencies: d.dependencies || []
    }));
  }
}

export const defaultGoalPlanner = new GoalPlanner();
