# Production Schedule Reflow

TypeScript implementation of a basic manufacturing schedule reflow system for the NaoLogic backend technical task.

The project prepares work-center availability, enriches work orders with manufacturing-order context, builds a dependency DAG, expands manufacturing quantity into repeated execution chains, and creates a simple dependency-aware schedule.

## What It Handles

- Work-order dependencies with topological sorting and cycle detection
- Work-center queues derived from the topological order
- Work only inside shift windows
- Maintenance windows as blocked time
- Closed work-center time shown in red on the visual schedule
- Manufacturing quantities from `manufacturingOrder.data.quantity`
- Repeated DAG executions such as `wo-blue-extrude#1`, `wo-blue-extrude#2`
- Static browser visualisation of the generated schedule

## Project Structure

```text
src/
  reflow/
    availability-map.ts      Builds per-work-center available intervals
    basic-scheduler.ts       Expands quantities and places work executions
    constraint-checker.ts    Validates input references and basic constraints
    dependency-graph.ts      Builds DAG, topological order, cycle errors
    reflow.service.ts        Public service API
    types.ts                 TypeScript domain and result types
  sample-data/
    basic-schedule.sample.ts Example work centers, manufacturing orders, work orders
    run-basic-schedule.ts    Console runner for the sample
  utils/
    date-utils.ts            UTC date helpers using Luxon
site/
  schedule-visualization/    Static Gantt-style visual schedule
scripts/
  write-visualization-data.mjs
```

## Setup

```bash
npm install
```

## Run Checks

```bash
npm run build
```

This runs TypeScript in strict mode without emitting files.

## Run The Sample Scheduler

```bash
npm run sample:basic
```

The sample prints:

- scenario notes
- topological work-order order
- per-work-center execution queues
- scheduled execution start/end times
- working segments split by closed time or maintenance

The bundled sample is intentionally large and varied: it uses exactly four work centers,
twelve manufacturing orders, thirty-nine work orders, maintenance-type work orders,
single-node DAGs, branching chains, and merge dependencies.

## Generate Visualisation Data

```bash
npm run visualization:data
```

This compiles the TypeScript and writes:

```text
site/schedule-visualization/schedule-data.json
```

The static page reads this JSON and renders the schedule.

## View The Schedule

Serve the `site` folder:

```bash
cd site
python -m http.server 4177 --bind 127.0.0.1
```

Then open:

```text
http://127.0.0.1:4177/schedule-visualization/
```

## Algorithm Overview

1. Validate work orders, work centers, manufacturing orders, and references.
2. Build availability per work center from shifts.
3. Subtract maintenance windows from availability.
4. Enrich each work order with its manufacturing order.
5. Build a dependency DAG where edges point from predecessor to successor.
6. Topologically sort the DAG. If there is a cycle, throw `DependencyCycleError`.
7. Expand each manufacturing quantity into per-unit execution nodes.
8. Schedule ready executions dynamically. Topological order is the stable fallback, but the
   scheduler can prioritize a BFS dependency path when it safely unlocks work on an earlier
   available work center.
9. Place each execution at the earliest time allowed by:
   - its dependencies,
   - its work center's next free time,
   - its work order start/end window,
   - available work-center intervals.

## Current Limitations

- This is still a basic scheduler, not an optimizer.
- It schedules greedily from ready executions, with topological order as a fallback.
- Maintenance work orders are not yet treated as fixed occupied intervals.
- There is no automated test suite yet.
- The visualisation is display-only.

Future improvements are intentionally left small and visible so the next scheduling phase can evolve cleanly.
