// The viewer's "Agent activity" lines (viewer/panels/log.mjs): what the agent
// asked for, then what Kinux decided, never mixed up.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeActivity } from '../viewer/panels/log.mjs';

test('a verified measurement names the solver\'s number; a rejected citation names the reason', () => {
  const m = describeActivity({ tool: 'kinux_propose', role: 'reviewer', arguments: { kind: 'measurement', domain: 'power', probe: 'V(VCC)', sources: { VBUS: 4.75 } },
    result: { id: 'P1', status: 'verified', measured: 3.83 } });
  assert.equal(m.agent, 'Reviewer (power)');
  assert.match(m.action, /P1 asks ngspice for V\(VCC\) with VBUS=4.75/);
  assert.equal(m.decision, 'verified: ngspice measured 3.83');
  const c = describeActivity({ tool: 'kinux_propose', role: 'reviewer', arguments: { kind: 'citation', doc: 'SPEC.md', quote: 'made up words' },
    result: { id: 'P2', status: 'rejected', reason: 'the quote does not occur in SPEC.md' } });
  assert.equal(c.ok, false);
  assert.match(c.decision, /^rejected: the quote does not occur/);
});

test('builder calls: a refusal is shown as a refusal, and findings carry the score as Kinux reported it', () => {
  const r = describeActivity({ tool: 'kinux_start_run', role: 'builder', isError: true, arguments: { force: true }, result: { error: 'invalid_arguments', message: 'kinux_start_run takes no argument "force"' } });
  assert.equal(r.ok, false);
  assert.match(r.decision, /refused: kinux_start_run takes no argument "force"/);
  const f = describeActivity({ tool: 'kinux_get_findings', role: 'builder', result: { score_text: '75.8% (50 killed / 66 checkable)', survivors: 16 } });
  assert.equal(f.decision, 'score 75.8% (50 killed / 66 checkable); 16 faults survived');
});
