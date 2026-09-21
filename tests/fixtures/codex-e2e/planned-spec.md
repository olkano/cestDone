Create a plan with exactly two numbered phases.

Phase 1 fixes only `sum.mjs`, runs `node --test`, and writes `phase-1.json` with `complete: true`.

Phase 2 verifies the tests again and writes `result.json` with the repository `ruleMarker`, supplied `houseMarker`, and `testsPassed: true`.

Do not use the network, send email, push, access cloud services, or run any job outside this fixture.
