# AI Prompt Documentation

This document extracts the main prompts that shaped the project and rewrites them as reusable AI instructions. It is intended for future contributors who want to continue the scheduler with the same domain language, constraints, and implementation direction.

## Project Prompt

Build a TypeScript production schedule reflow project for a manufacturing technical task.

The system should prepare work-center availability, enrich work orders with manufacturing-order context, build a dependency graph, generate a baseline schedule, visualize it, and support basic delay reflow experiments. The implementation should prefer readable scheduling logic over premature optimization.

## Core Domain Prompt

Use the following domain model:

- A `ManufacturingOrder` represents demand for a product, quantity, and due date.
- A `WorkOrder` represents one production or maintenance step assigned to a work center.
- An `EnrichedWorkOrder` should copy the manufacturing-order fields onto each work order so the scheduling algorithm can read all needed context from one object.
- `dependsOnWorkOrderIds` defines dependency edges. If `B -> C`, then `B` must finish before `C`.
- Manufacturing quantity means the same work-order chain must be executed once per required unit.
- Maintenance windows and closed work-center time reduce availability.
- Maintenance work orders are still nodes in the dependency graph, not fixed occupied intervals, unless a later scheduling phase explicitly changes that rule.

## Availability Prompt

Create an availability map for every work center over a fixed planning horizon.

Default horizon:

```text
2026-01-01T00:00:00.000Z to 2026-02-01T00:00:00.000Z
```

For each work center and each date:

- keep the available intervals,
- calculate `workingMinutes` for that date,
- calculate `cumulativeWorkingMinutes` from the horizon start through that date,
- mark closed time separately so the visual schedule can show non-working time in red,
- subtract maintenance windows from production availability.

## Dependency Graph Prompt

Build a directed acyclic graph from all enriched work orders.

Rules:

- Every work order is a graph node.
- Each `dependsOnWorkOrderIds` entry creates a predecessor-to-successor edge.
- Run a topological sort.
- If a cycle exists, throw an error that points to the cycle path.
- If the graph is a DAG, save the topological result for later scheduling.

Topological tie-break order:

1. `workOrder.startDate` ascending
2. `workOrder.endDate - workOrder.startDate` ascending, so shorter valid windows are handled earlier
3. `manufacturingOrder.dueDate` ascending
4. `workOrderNumber` ascending
5. `docId` ascending

## Baseline Scheduling Prompt

Create a simple baseline scheduler.

For each work center:

- create a queue of executable work orders in topological order,
- expand manufacturing quantity into repeated execution chains,
- preserve dependency order between repeated unit executions,
- walk linearly through the planning horizon,
- place each execution in the earliest available work-center interval where it fits,
- respect work-order start and end windows,
- respect dependency completion times,
- keep work split into segments when closed time or maintenance interrupts execution.

This phase is intentionally simple. It should prove that the prepared data, graph, and availability model work together before deeper optimization is added.

## BFS Prioritization Prompt

Improve the greedy scheduler with a small optimization.

When one work center is available but another required work center is not, inspect the dependency graph with BFS to find the closest downstream node that can run on a currently useful work center. Calculate the amount of work needed to unlock that node.

Prioritize that path only if:

- the required predecessor path can be completed,
- no work-order deadlines are lost,
- dependencies remain valid,
- the change increases useful output compared with blindly following topological order.

Topological order remains the stable fallback when no safe BFS path is found.

## Delay Reflow Prompt

Support an interactive delay experiment in the visual schedule.

When the user clicks a scheduled work-order card:

- extend that execution by 20 working minutes,
- draw a second schedule below the baseline schedule,
- color the extended delay portion purple,
- take the next affected work order from the formed schedule,
- remove it from its original position,
- search linearly for a new gap where it fits,
- respect work-center availability, maintenance, closed time, and dependencies,
- move dependent executions only when needed,
- show what moved, where it moved, and why.

The reflow should minimize:

- total delay introduced: `sum(new_end_date - original_end_date)`,
- number of work orders affected.

The total delay calculation should compare each moved execution against its own original end time. It should not count unrelated horizon gaps or closed time as delay unless the execution actually ends later than before.

## Metrics Prompt

Track schedule quality metrics for both the baseline and reflowed schedules.

For every work center:

- utilization: `total scheduled working minutes / total available shift minutes`,
- total working time,
- total available shift time,
- idle time,
- idle window count,
- largest idle window.

For every week in the planning horizon:

- calculate total scheduled working minutes across all work centers,
- calculate total available shift minutes across all work centers,
- display weekly efficiency as `working / available`,
- show idle time for the week.

Example interpretation:

If four machines are available for the same week and two work constantly while two do not work, weekly efficiency is `50%`.

## Visualization Prompt

Create a simple static site to visualize the generated schedule.

The site should show:

- baseline schedule as a Gantt-style timeline,
- reflowed schedule after a delay click,
- work centers,
- manufacturing orders grouped with their work-order steps,
- topological order,
- per-work-center queues,
- maintenance windows,
- closed work-center time in red,
- tooltips or click/hover details for cards that are too small to read,
- dependencies for each work order,
- utilization and weekly efficiency metrics.

The UI is display-only. It does not need editing functionality.

## Sample Data Prompt

Generate varied sample data for testing and visualization.

Sample requirements:

- exactly four work centers,
- multiple manufacturing orders,
- work orders with different start and end windows,
- wider start/end intervals so the scheduler decides placement,
- maintenance windows,
- maintenance work orders with `isMaintenance: true`,
- single-node DAGs,
- multi-step chains,
- branching dependencies,
- merge dependencies,
- manufacturing quantities from 2 to 4,
- all dates inside the planning horizon.

Also create scenario samples for error testing:

- dependency cycle,
- missing dependency,
- impossible work-order window,
- maintenance split behavior,
- multi-parent merge behavior,
- massive varied schedule.

## Error Handling Prompt

The project should make scheduling errors visible and understandable.

Detect and report:

- dependency cycles,
- missing dependency references,
- missing work-center references,
- missing manufacturing-order references,
- work orders that cannot fit inside their allowed date window,
- schedules that cannot fit inside the planning horizon.

Error scenarios should be selectable in the visualization site so the behavior can be inspected without changing source code.

## Implementation Prompt

Implementation requirements:

- all core scheduling code must be TypeScript,
- use strict TypeScript types,
- keep algorithm code under `src/reflow`,
- keep sample data under `src/sample-data`,
- keep generated visualization data under `site/schedule-visualization`,
- prefer readable models and small functions,
- add core comments where the scheduling logic is not obvious,
- keep the README and project context updated.

## Git And Delivery Prompt

Work like a senior developer preparing a GitHub submission.

Expected delivery behavior:

- commit meaningful milestones,
- use clear commit messages,
- keep generated artifacts in sync with source data,
- run TypeScript build checks before final delivery,
- verify the visualization after UI changes,
- push completed work to GitHub when requested.

## Future Prompt Seeds

The following prompts are natural next steps for this project:

- "Implement a cost function that compares multiple valid reflow options and chooses the one with the least total delay and fewest affected work orders."
- "Add automated tests for cycle detection, quantity expansion, maintenance splitting, and delay reflow."
- "Change maintenance work orders from graph-only nodes into fixed occupied intervals and explain the trade-offs."
- "Add a compact critical-path view for each manufacturing order."
- "Add per-product lateness metrics based on manufacturing-order due dates."
- "Export the baseline and reflowed schedules as JSON for backend integration."
