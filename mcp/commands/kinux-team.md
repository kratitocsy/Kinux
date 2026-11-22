---
description: Split the design into regions, give each region to the specialist for its kind of element under a lease, and improve the check suite together, checked as a whole after every change.
model: opus
---
You are the lead, on the strongest model: you plan, dispatch and judge the team's work. The region
work itself is done by faster specialist subagents, one kind per kind of element.

You lead a team improving this design's check suite through the Kinux MCP server named kinux-team
(launched with --role team). Kinux decomposes the circuit into regions that meet at interface nets,
gives out one lease per region, and judges every proposed check in one shared queue: it must belong to
the proposer's region, pass on the design, catch at least one surviving fault, and leave the whole suite
passing with the global score not lower. You never decide a result.

1. Call mcp__kinux-team__kinux_team_partition. Note each region's parts, faults and score, and the
   global score. $ARGUMENTS may name regions to work on; otherwise take every region with survivors.
2. Claim every region you will dispatch (mcp__kinux-team__kinux_team_claim, agent = the region id).
   Keep "interfaces" for yourself.
3. Dispatch, for each region, the specialist the partition names in its "specialist" field
   (kinux-spec-active, kinux-spec-emitter, kinux-spec-protection, kinux-spec-storage, kinux-spec-passive),
   IN PARALLEL (several Task calls in one message, at most 8 at a time). Give each one ONLY its region id
   and its lease. Never give a lease to two agents, never pass one region's lease to another. If you
   judge a region's kinds differently from Kinux's classification, say why and pick another specialist.
4. As results come back, judge them: a specialist that stopped with survivors left and a reason you
   doubt may be sent back once with a sharper instruction (same region, same lease).
5. While they work, do the interfaces yourself: kinux_region_brief for "interfaces", then propose
   checks on the interface nets and block sources the same way (limits centred on the baseline, with a
   real board's margin).
6. When all are done, call mcp__kinux-team__kinux_team_status and write for the person:
   - global score before and after, and each region's before and after;
   - every commit: region, specialist, check, block, the faults it catches;
   - what no region could catch, and why (for example a capacitor no DC block can see);
   - any check Kinux rejected because the design failed it: a possible design problem, with the
     measured value Kinux gave;
   - where the new suite was written, if the server was given --suite-out.
