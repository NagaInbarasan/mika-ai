# MIKA Minecraft ALife Bot --- Project Specification

## 1. Project goal

Build a Minecraft Java Edition simulation bot that can:

1.  Connect to a local Minecraft Java world.
2.  Observe its environment and internal state.
3.  Select goals and make decisions using an LLM.
4.  Execute validated actions through a bot-control framework.
5.  Measure the outcomes of actions.
6.  Learn from mistakes, feedback, and verified outcomes.
7.  Store every meaningful observation, decision, action, correction,
    and outcome in a structured dataset.
8.  Prepare the dataset for preprocessing, evaluation, and future model
    training.

**Important:** Antigravity is the development environment, not the
runtime bot or its LLM. The bot must run as a separate Node.js
application.

## 2. Recommended initial stack

-   **Development:** Google Antigravity
-   **Minecraft bot framework:** Mineflayer (Node.js)
-   **Navigation:** `mineflayer-pathfinder`
-   **Reasoning model:** Gemini Flash through the official Google Gen AI
    SDK
-   **Storage:** JSON Lines (`.jsonl`) files for the first version
-   **Configuration:** `.env` plus validated configuration
-   **Optional visualization:** `prismarine-viewer`
-   **Future preprocessing:** Python with pandas; optionally
    SQLite/PostgreSQL when logs grow

Use the currently supported Gemini Flash model ID documented by Google
AI Studio / Gemini API at implementation time. Do not hard-code an
obsolete model name. Read the model ID from an environment variable such
as `GEMINI_MODEL`.

Official references: - Mineflayer:
https://github.com/PrismarineJS/mineflayer - Mineflayer API:
https://github.com/PrismarineJS/mineflayer/blob/master/docs/api.md -
Gemini API models: https://ai.google.dev/gemini-api/docs/models - Gemini
structured outputs:
https://ai.google.dev/gemini-api/docs/structured-output - Gemini
function calling: https://ai.google.dev/gemini-api/docs/function-calling

## 3. Core architecture

Implement these modules with clear interfaces:

1.  **Minecraft connection**
    -   Connect to a local server, preferably `localhost:25565`.
    -   Do not assume TLauncher automatically provides a server.
    -   The user must launch a compatible Java world/server and
        configure authentication appropriately.
    -   Keep Minecraft version configurable or automatically detected
        where supported.
    -   Log connection, spawn, kick, and error events.
2.  **Observation collector**
    -   Collect a compact state snapshot when a decision is needed.
    -   Include position, health, food level, saturation if available,
        dimension, time/weather if available, inventory summary, nearby
        blocks/entities, nearby threats, and current task.
    -   Do not send an unlimited world dump to the LLM. Filter and bound
        observations.
3.  **Goal and planning layer**
    -   Ask Gemini Flash for a high-level goal or next step only when
        necessary.
    -   Use structured JSON output with a strict schema.
    -   The response must contain fields such as:
        -   `goal`
        -   `reason_summary`
        -   `action`
        -   `arguments`
        -   `expected_outcome`
        -   `risk`
        -   `confidence`
    -   Treat model output as untrusted input. Validate every field and
        reject unsupported actions.
    -   Do not ask the model to produce arbitrary JavaScript or shell
        commands.
4.  **Action validator and executor**
    -   Expose a small allowlist of actions, such as:
        -   `look_around`
        -   `move_to_safe_location`
        -   `follow_path_to`
        -   `collect_nearby_resource`
        -   `inspect_inventory`
        -   `eat_food`
        -   `craft_known_recipe`
        -   `place_block_at_safe_position`
        -   `stop`
    -   Implement each action in normal code with timeouts,
        preconditions, and error handling.
    -   Use pathfinding instead of asking the LLM to issue movement
        commands every tick.
    -   Add limits for distance, duration, resource use, and retry
        count.
    -   Stop or enter a safe state if the action fails repeatedly,
        health is critical, or the bot becomes stuck.
5.  **Outcome evaluator**
    -   Capture state before and after an action.
    -   Record whether the action succeeded, failed, timed out, was
        interrupted, or had an unknown result.
    -   Calculate measurable deltas, including health, food, inventory,
        position, time spent, damage taken, and task progress where
        applicable.
    -   Do not label an action successful merely because the API call
        returned without an error.
6.  **Mistake detection and feedback learning**
    -   Detect and label failures using observable evidence, including:
        -   action errors or timeouts;
        -   pathfinding failure or getting stuck;
        -   no expected inventory/state change;
        -   predicted outcome differs from actual outcome;
        -   repeated attempts at the same failed action;
        -   avoidable damage, resource loss, or death;
        -   goal not completed within its budget.
    -   Categorize each failure (navigation, missing prerequisite,
        invalid action, resource planning, threat response, model
        prediction error, or unknown).
    -   Create a correction record containing the failed state,
        attempted action, observed evidence, failure category, likely
        cause if supported by evidence, alternative action, and result
        of retry.
    -   Ask Gemini for a concise diagnosis and recovery proposal when
        needed, but treat the proposal as a hypothesis. Check it against
        actual world state and action preconditions before executing.
    -   On a failure, stop blind retries. Permit a small bounded number
        of attempts, then change strategy, request a new plan, or end
        the task safely.
    -   After a correction succeeds, store the failed attempt and
        successful recovery together as a learning example.
    -   Maintain a **reusable skill/mistake memory** in a simple JSON or
        SQLite store. Each entry should include a situation pattern,
        previous failure, validated correction, evidence, confidence,
        and times successfully reused.
    -   Retrieve relevant past mistakes before planning in similar
        states. Do not blindly apply a memory entry if the current
        conditions differ.
    -   Support explicit user feedback, for example: `good decision`,
        `bad decision`, `you wasted resources`, or `try a safer route`.
        Store the feedback with the exact run/episode/step IDs it refers
        to.
    -   Treat user feedback as a label or preference, not automatic
        proof that an action was objectively correct. Compare it with
        world evidence and safety constraints.
    -   Keep raw logs immutable. Store feedback, diagnosis, and
        corrected labels as additional linked records so later
        corrections never erase the original event.
    -   Do not automatically fine-tune the LLM during live gameplay.
        First accumulate reviewed examples, then preprocess and evaluate
        them offline.
    -   Track whether a correction actually improved future performance.
        A remembered fix that repeatedly fails should be downgraded or
        marked stale.
7.  **Experience recorder**
    -   Append one JSON object per event/transition to
        `data/raw/experiences.jsonl`.
    -   Append mistake and feedback events to `data/raw/feedback.jsonl`
        or a unified versioned event log.
    -   Never overwrite earlier experiences by default.
    -   Include timestamps, run ID, episode ID, step number, bot
        version, Minecraft version if known, model ID, prompt/schema
        version, and random seed if controlled.
    -   Keep API keys, access tokens, passwords, and other secrets out
        of logs.
8.  **Preprocessing pipeline**
    -   Preserve raw logs as immutable source data.
    -   Create a separate script that validates records, removes or
        flags malformed entries, deduplicates by event ID, normalizes
        fields, links feedback to the right transition, and writes
        processed data to `data/processed/`.
    -   Record why a row was rejected or transformed.
    -   Produce separate datasets for action prediction, outcome
        prediction, and failure/recovery examples.
    -   Split training and evaluation data by episode or world/seed, not
        by randomly splitting adjacent steps from the same trajectory.

## 4. Decision and learning loop

Use this loop for meaningful decisions, not for every Minecraft game
tick:

1.  Collect observation.
2.  Check safety rules and current task.
3.  Retrieve relevant prior skills and mistake memories.
4.  Decide whether a new LLM plan is needed.
5.  If needed, send a compact observation, relevant memories, and
    allowed-action list to Gemini Flash.
6.  Parse and validate the structured response.
7.  Capture the pre-action state.
8.  Execute one bounded action.
9.  Collect the resulting observation.
10. Evaluate the outcome against the expected outcome.
11. If the action fails, classify the failure and stop blind retries.
12. Ask for a revised plan if needed; validate it and attempt a bounded
    recovery.
13. Store the original failure, feedback, correction, and retry result
    as linked records.
14. If a correction is verified, update reusable skill/mistake memory.
15. Append the transition and episode metrics to raw logs.
16. Continue until the goal is complete, the episode ends, or a stop
    condition occurs.

Prefer deterministic code for movement, pathfinding, repeated
interactions, and safety checks. Use Gemini for high-level planning,
prioritization, interpreting unexpected states, and selecting recovery
strategies. Add request timeouts, retry with exponential backoff for
transient errors, respect `Retry-After` when supplied, and cap retries.

## 5. Experience record schema

Use a versioned schema. A representative record:

``` json
{
  "schema_version": "1.0",
  "event_id": "generated-unique-id",
  "run_id": "run-001",
  "episode_id": "episode-001",
  "step": 12,
  "timestamp": "ISO-8601 timestamp",
  "environment": {
    "minecraft_version": "detected-version",
    "world_id": "local-world-or-seed-hash",
    "dimension": "overworld"
  },
  "observation_before": {
    "position": {"x": 0, "y": 64, "z": 0},
    "health": 20,
    "food": 18,
    "inventory": [{"item": "oak_log", "count": 3}],
    "nearby_entities": [],
    "nearby_resources": []
  },
  "goal": "collect wood safely",
  "available_actions": ["inspect_inventory", "collect_nearby_resource", "stop"],
  "decision": {
    "action": "collect_nearby_resource",
    "arguments": {"resource": "oak_log", "max_distance": 8},
    "reason_summary": "A nearby tree can supply wood.",
    "expected_outcome": "inventory oak logs increases",
    "risk": "low",
    "confidence": 0.78
  },
  "execution": {
    "status": "success",
    "duration_ms": 2400,
    "error_code": null
  },
  "observation_after": {
    "position": {"x": 2, "y": 64, "z": 1},
    "health": 20,
    "food": 18,
    "inventory": [{"item": "oak_log", "count": 5}]
  },
  "outcome": {
    "task_progress": 1,
    "health_delta": 0,
    "food_delta": 0,
    "resource_delta": {"oak_log": 2},
    "predicted_outcome_met": true,
    "reward": 1.0
  },
  "learning": {
    "failure_detected": false,
    "failure_category": null,
    "feedback_event_ids": [],
    "correction_applied": false,
    "correction_verified": null
  },
  "model": {
    "provider": "google",
    "model_id": "configured-model-id",
    "prompt_version": "1.0"
  }
}
```

All example values are illustrative. Use actual measured values at
runtime. Distinguish missing data from zero. Do not invent an internal
chain of thought: record a concise reason summary, chosen action,
predicted outcome, and observable evidence.

### Example mistake and correction record

``` json
{
  "schema_version": "1.0",
  "event_id": "feedback-event-id",
  "event_type": "correction",
  "run_id": "run-001",
  "episode_id": "episode-001",
  "step": 13,
  "related_event_id": "failed-action-event-id",
  "failure_category": "missing_prerequisite",
  "observed_evidence": "Crafting failed because the bot had no planks.",
  "previous_action": "craft_sticks",
  "correction_proposed": "craft_planks_from_logs_first",
  "correction_validation": "inventory contained logs and recipe was available",
  "retry_result": "success",
  "memory_update": "Craft planks before attempting stick recipe when planks are missing"
}
```

## 6. Data to collect

Collect at least these categories:

-   **Environment:** position, dimension, time, weather, nearby blocks
    and entities, hazards.
-   **Agent state:** health, food, inventory, equipment, status effects,
    current task.
-   **Decision:** goal, allowed options, selected action, concise reason
    summary, confidence if provided, predicted result.
-   **Execution:** action start/end, status, duration, retries, errors.
-   **Outcome:** state deltas, task progress, damage, resource
    gain/loss, survival, reward.
-   **Mistakes:** failure category, evidence, repeated failure count,
    likely cause, recovery plan, retry result.
-   **Feedback:** user or evaluator rating, exact event referenced,
    feedback text/category, resulting correction.
-   **Learning signals:** prediction errors, successful recovery,
    repeated failures, and whether a stored fix worked later.
-   **Reproducibility:** episode/run IDs, world/seed identifier where
    available, software versions, schema and prompt versions.

## 7. Reward design

Start with simple, measurable rewards. For example:

-   Positive reward for completing a task or obtaining a required
    resource.
-   Small penalty for wasted time or repeated failed actions.
-   Penalty for taking avoidable damage or losing important resources.
-   Strong penalty for death if survival is the task.
-   No reward merely for generating a long explanation.

Avoid reward loopholes. Track several metrics separately rather than
relying on one reward number. Do not train on model-generated success
labels without checking the actual world outcome. User feedback can
shape preferences, but it must not override safety rules or objective
state evidence.

## 8. Safety and operational constraints

-   Test in a disposable local world first.
-   Require an explicit start command and support an immediate stop
    command.
-   Limit action duration and retries.
-   Never expose API keys in source code; use `.env` and add it to
    `.gitignore`.
-   Do not let the LLM execute arbitrary code or shell commands.
-   Stop on disconnection, invalid state, repeated pathfinding failure,
    or critical health.
-   Avoid destructive actions near valuable builds unless explicitly
    enabled.
-   Respect server rules and use only accounts and worlds the user is
    authorized to control.
-   Log API errors without secrets; handle rate limits and quota
    exhaustion gracefully.
-   If Gemini is unavailable, pause planning or use a clearly defined
    safe fallback. Do not loop indefinitely.

## 9. Milestones and acceptance tests

### Milestone A --- Connection

-   Bot connects to the configured local server.
-   Spawn, disconnect, kick, and error events are logged.
-   Bot can be stopped cleanly.

### Milestone B --- Observation and data logging

-   Bot records a state snapshot.
-   A valid JSONL record is appended to disk.
-   A parser can read every generated record.

### Milestone C --- Deterministic actions

-   Bot can inspect inventory and perform one bounded, safe action.
-   Before/after state is recorded.
-   Failed actions are marked as failures, not successes.

### Milestone D --- Gemini planning

-   Model returns schema-valid JSON.
-   Invalid or unsupported actions are rejected.
-   API timeouts and rate limits do not crash the bot.
-   LLM calls occur at decision points, not every game tick.

### Milestone E --- Mistakes and feedback

-   Intentionally trigger a safe, recoverable failure, such as
    requesting a craft action without a prerequisite.
-   Bot detects and classifies the failure from observable evidence.
-   It stops blind retries, proposes a correction, validates
    prerequisites, and retries within a limit.
-   Original failure and recovery are stored as linked events.
-   User can label a decision good/bad and the feedback is linked to the
    correct event.
-   Repeating a comparable scenario retrieves the validated correction.
-   Stale or unsuccessful corrections can be downgraded.
-   A test verifies that user feedback cannot bypass action validation
    or safety rules.

### Milestone F --- Episodes and evaluation

-   Bot completes a small objective such as collecting a target number
    of logs and returning to a safe point.
-   Episodes end with a reason and summary metrics.
-   The same scenario can be repeated for comparison.

### Milestone G --- Preprocessing

-   A script validates and normalizes raw JSONL.
-   Invalid records are reported.
-   Feedback and correction records are linked correctly.
-   Separate failure/recovery examples are exported.
-   Processed files are written separately.
-   Train/evaluation splits do not leak adjacent steps from the same
    episode.

### Milestone H --- Future learning

-   Compare a scripted baseline with the LLM planner.
-   Evaluate completion rate, time, resource efficiency, damage, failed
    actions, successful recovery rate, recurrence of known mistakes, and
    API calls.
-   Only after reliable data collection, explore supervised fine-tuning,
    a world model, or reinforcement learning.

## 10. Project layout

``` text
mika-minecraft/
  src/
    config/
    minecraft/
      connect.js
      observe.js
    planner/
      gemini.js
      action-schema.js
    actions/
      index.js
      navigation.js
      resources.js
    evaluation/
      outcome.js
      reward.js
    learning/
      mistake-detector.js
      feedback.js
      memory.js
      recovery.js
    data/
      recorder.js
      preprocess.js
    episodes/
      runner.js
    index.js
  data/
    raw/
      experiences.jsonl
      feedback.jsonl
    processed/
    reports/
  tests/
  .env.example
  .gitignore
  package.json
  README.md
```

Adjust filenames if needed, but preserve separation between world
interaction, planning, execution, evaluation, learning, and data
storage.

## 11. Instructions for the coding agent

Implement this incrementally. First inspect the installed Node.js
version, Minecraft version, available server setup, and current project
files. Do not overwrite existing work without checking it.

At each milestone: 1. Explain which files will be created or changed. 2.
Implement only the current milestone. 3. Run tests or provide exact
commands for manual verification. 4. Fix errors before proceeding. 5. Do
not claim a feature works unless it has been tested. 6. Keep secrets in
environment variables. 7. Update the README with installation,
configuration, startup, stop, and troubleshooting instructions.

Begin with Milestone A, then continue only after the connection test
succeeds. Build mistake detection, feedback, and recovery after the
basic action logging works. Do not claim the bot is learning until tests
demonstrate that it retrieves a validated correction and performs better
on a repeated scenario.
