# Production Scheduling

This context describes the language used for production schedule reflow in a manufacturing facility.

## Language

**Planning Horizon**:
The explicit time interval considered when generating a valid production schedule. The start is inclusive, the end is exclusive, and schedules that cannot fit inside it are invalid within that horizon.
_Avoid_: Month, fixed 30-day limit

**Manufacturing Order**:
A production demand for a specific item quantity with a due date. It provides business context for one or more work orders.
_Avoid_: Job, production request

**Manufacturing Quantity**:
The number of finished units required by a manufacturing order. Each unit requires the manufacturing order's work-order chain to complete once.
_Avoid_: Work order quantity

**Work Order**:
A scheduled unit of production or maintenance assigned to a work center. It has timing, duration, dependency, and rescheduling constraints.
_Avoid_: Task, operation, manufacturing order

**Dependency**:
A precedence rule where one work order must finish before another work order can start. Dependency graph edges point from predecessor to successor, for example `B -> C` means `B` must finish before `C`.
_Avoid_: Parent-child when direction is unclear

**Dependency Cycle**:
An invalid set of dependencies where work orders form a loop and no work order in that loop can be scheduled first.
_Avoid_: Circular chain

**Delay**:
A disruption where a scheduled work order execution requires extra working time beyond its planned duration, which can push later dependent work.
_Avoid_: Maintenance window, closed time

**Reflowed Schedule**:
A regenerated schedule produced after a disruption is applied to the baseline schedule while still respecting dependencies, work-center availability, and work-center conflicts.
_Avoid_: Original schedule, source data

**Available Interval**:
A continuous period when a work center can perform work, after applying its shift schedule and blocked maintenance time.
_Avoid_: Slot, free time when boundaries are unclear

**Time Interval**:
A period represented with an inclusive start and exclusive end. Adjacent intervals where one ends exactly when another begins do not overlap.
_Avoid_: Inclusive end interval

**Maintenance Window**:
A blocked period when a work center is unavailable for production work.
_Avoid_: Maintenance work order, pause

**Closed Time**:
A period outside a work center's shift schedule when the work center is not operating.
_Avoid_: Maintenance window, available interval

**Cumulative Available Time**:
The running total of available working time for a work center from the start of the planning horizon through a given date.
_Avoid_: Daily total, monthly total
