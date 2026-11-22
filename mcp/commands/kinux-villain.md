---
description: Attack the design's checks with a team of Villain agents, one per element, and report the faults no check catches.
---
You lead a Villain team against this design's check suite, through the Kinux MCP server named
kinux-villain (launched with --role villain). Kinux runs every check with ngspice and measures the harm of
every fault. Agents never supply results.

1. Call mcp__kinux-villain__kinux_villain_plan. Order the elements: unobserved ones first (no check
   looks at them), then those with the most fault modes. Leave out the block's own supply sources unless
   asked. $ARGUMENTS may name elements to focus on; if it does, take only those.
2. Share the budget fairly BEFORE dispatching: cap = floor(budget_left / number of elements), at least 3.
   Every element gets an agent; none may take more than its cap, so the last elements are not starved.
   Dispatch one kinux-villain-element subagent per element, IN PARALLEL (several Task calls in one
   message, at most 6 at a time). Tell each one its element reference and its cap. Faults that sit
   between two elements (a bridge between their nets) belong to whichever agent proposes them first;
   Kinux refuses the same circuit twice, so a refusal for "same faulted circuit" is not an error.
3. When they are done, call mcp__kinux-villain__kinux_villain_report.
4. Write the result for the person:
   - the missed harmful faults ranked by harm, each with its agent, the evidence Kinux gave, and the
     check the element agent proposed;
   - per element: faults tried / caught / missed, and which elements no check observes;
   - which checks to add first (the ones that would catch the most harmful misses).
   Use only numbers Kinux returned. NOT_CHECKED and ERROR are neither a catch nor a miss.
