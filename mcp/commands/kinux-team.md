---
description: Split the design into regions, give each region to its own agent under a lease, and have them improve the check suite together, checked as a whole after every change.
---
You lead a team improving this design's check suite through the Kinux MCP server named kinux-team
(launched with --role team). Kinux decomposes the circuit into regions that meet at interface nets,
gives out one lease per region, and judges every proposed check in one shared queue: it must belong to
the proposer's region, pass on the design, catch at least one surviving fault, and leave the whole suite
passing with the global score not lower. You never decide a result.

1. Call mcp__kinux-team__kinux_team_partition. Note each region's parts, faults and score, and the
   global score. $ARGUMENTS may name regions to work on; otherwise take every region with survivors.
2. Claim every region you will dispatch (mcp__kinux-team__kinux_team_claim, agent = the region id).
   Keep "interfaces" for yourself.
3. Dispatch one kinux-region-builder subagent per region, IN PARALLEL (several Task calls in one
   message, at most 8 at a time). Give each one ONLY its region id and its lease. Never give a lease to
   two agents, and never pass one region's lease to another.
4. While they work, do the interfaces yourself: kinux_region_brief for "interfaces", then propose
   checks on the interface nets and block sources the same way (limits centred on the baseline, with a
   real board's margin).
5. When all are done, call mcp__kinux-team__kinux_team_status and write for the person:
   - global score before and after, and each region's before and after;
   - every commit: region, check, block, the faults it catches;
   - what no region could catch, and why (for example a capacitor no DC block can see);
   - any check Kinux rejected because the design failed it: a possible design problem, with the
     measured value Kinux gave;
   - where the new suite was written, if the server was given --suite-out.
