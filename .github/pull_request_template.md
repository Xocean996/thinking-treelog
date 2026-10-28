## What this changes

<!-- One paragraph. If it fixes an issue, link it. -->

## How it was verified

<!--
Not "tests pass" alone — say what you actually ran and what you saw.
Paste the command and the relevant output.
-->

```bash
npm run verify
```

## Checklist

- [ ] `npm run verify` passes locally
- [ ] New behaviour has a test that would fail without the change
- [ ] If a rule or judgement changed, the README says which numbers it rests on
- [ ] No new runtime dependency was added to `core`, `cli`, or `mcp`
- [ ] If the panel changed, the `BUILD` marker was bumped
