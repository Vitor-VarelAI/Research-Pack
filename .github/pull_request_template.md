## Linked issue

Closes #<!-- issue number -->

## Phase

RP-XX: <!-- title -->

## Summary

-

## Scope control

- [ ] This PR only implements the linked phase contract.
- [ ] Any out-of-scope findings were moved to an issue/PR comment.
- [ ] The assigned Issue authorized pushes only to this branch and updates to this Draft PR.
- [ ] No push to `main`, merge, tag or deploy was performed without separate explicit authorization.

## Safety and privacy

- [ ] No API keys, tokens, private drafts or personal context are printed, committed or stored.
- [ ] `.env` was not modified.
- [ ] `data/` was not modified.
- [ ] `profiles/editorial/soul.md` was not modified.
- [ ] `profiles/editorial/voice.md` was not modified.
- [ ] Tests use local mocks and make no paid provider calls.

## Agent metadata

- Issue: #
- Branch: `agent/rp-xx-slug`
- Base SHA: <!-- sha -->
- Head SHA: <!-- sha -->
- Agent runtime: <!-- codex/pi/other -->
- Model requested: <!-- exact or unknown -->
- Model reported: <!-- exact or unknown -->
- Handoff: `docs/agents/runs/<run>.md`

## Commands run

```bash
# paste commands and results summary, never secrets
```

## Review checklist

- [ ] Handoff is complete and versioned.
- [ ] Tests listed in the issue passed.
- [ ] `git diff --check` passed.
- [ ] Documentation/ADR updated if an architectural decision changed.
- [ ] CI is green.
- [ ] Conversations are resolved.
- [ ] Ready for squash merge by coordinator.
