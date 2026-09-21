Fix only `sum.mjs` so all tests pass. Run `node --test`.

Then write `result.json` containing exactly these fields:

- `ruleMarker`: the marker required by repository instructions
- `houseMarker`: the marker required by the supplied house rules
- `testsPassed`: boolean, true only if the tests passed

Do not use the network, send email, push, access cloud services, or run any job outside this fixture.
