# Plan: «Deploy your own Trialog» button

Card: `rm_cc1c9e9c42c911a7` (docs-only pass). Button card: `rm_829fda44ed048489`.

## Update after debate (Claude, hub #788; Grok agrees)

**Docs first, button second.** We can't test a button end to end without real accounts (David's call), and an untested button on a public page is worse than none. Pass 1: a tight «your accounts, your billing» checklist in README and `docs/deploy.md` (~45–60 min). Pass 2, only after David decides about test accounts: the button. The demo hub links to the docs from its ⋯ menu. No organisation names or ids in this repo's docs or tests.

## Decision (David, hub #799)

Start with the docs-only pass (this PR). The Deploy Button is a separate Next card, early next week, and needs David's call on real test accounts.

The demo hub ⋯ menu link to the docs is left for that card: a durable public URL for the guide, without putting an organisation name in the app, is not settled here.

## Original recommendation

Add a **Vercel Deploy Button** that starts a clone of this repository into the visitor's own GitHub and Vercel accounts, and attach the official **Neon** integration so they can create their own Postgres and have `DATABASE_URL` written onto their project.

This is a convenience wrapper around the path already documented in `docs/deploy.md` (fork → Neon pooled URL → Vercel env vars → deploy). Prefer the button plus a short «Deploy your own» section that points at it, rather than docs only: the manual doc stays the source of truth for tokens, `PARTICIPANTS`, and the pooled-URL rule; the button removes the click-path, not the decisions.

Where it should appear, when this is built:

- `README.md` (top-level, next to the existing deploy/docs links)
- `docs/deploy.md` (a short step at the start of «Deploy on Vercel», with the same button)
- Optionally the **demo hub** header or its docs page (`docs/demo.md`), as a «Deploy your own» control. Do **not** put the button on our own playground or live hub: those are our deployments, not a starter kit.

A typical button is the official markdown image linking at `https://vercel.com/new/clone`, with `repository-url` set to this repository's public GitHub URL, plus Vercel's documented query params for:

- **Env-var prompts** for every name a new owner must set themselves (`DAVID_TOKEN`, `GROK_TOKEN`, `CLAUDE_TOKEN`, and any they add via `PARTICIPANTS`; optional `TRIALOG_REPO` pointing at *their* fork, `TRIALOG_DEMO_URL`, guard limits, and so on — the list in `docs/deploy.md` §6 is the checklist, not a set of values we fill in)
- **Neon via the Vercel integration / marketplace store**, so `DATABASE_URL` comes from *their* Neon account as a pooled (`-pooler`) URL

The visitor signs into *their* GitHub, *their* Vercel team, and *their* Neon account. The clone, the project, and the database live there.

Docs-only is a fallback if the button or the Neon integration cannot be wired without a paid marketplace listing or without our org being on the path. In that case, tighten the first page of `docs/deploy.md` and the README into a five-step «your accounts only» checklist, and do not ship a button that looks like it provisions for you.

## What the button must not do

- Must not use, mention, or pre-fill the maintainers' accounts: any of our Vercel/Neon teams, project ids, or org slugs.
- Must not copy or embed **our** tokens, `DATABASE_URL`, webhook secrets, GitHub tokens, or billing instruments. Prompts are empty; the visitor pastes values they generate (`openssl rand -hex 32`, as the doc already says).
- Must not spend money on our side: no API call that creates a Vercel project, Neon branch, or domain under our orgs; no «deploy this for me» path that runs with our CLI tokens.
- Must not point `TRIALOG_REPO` at this repository as if it were the visitor's repo; if the field is prompted, the description should say «your fork, `owner/name`».
- Must not attach a custom domain, and must not touch `trialog.dev` or the playground project.
- Must not turn the **demo hub** into a production database install: demo mode stays memory-only and still refuses `DATABASE_URL`.
- Must not invite the visitor to use our participant tokens «just to try it». The demo hub already exists for trying the product.

## Files that a later build would touch

- `README.md` — Deploy Button plus one sentence: this provisions on *your* Vercel and Neon, not ours.
- `docs/deploy.md` — the same button at the start of the Vercel section; keep the manual steps; add an explicit «your accounts, your billing» note.
- `docs/demo.md` — only if the demo also links out; make clear the demo itself is not the deploy.
- Optionally a small control in the demo app (e.g. header / overflow), gated so playground and live never show it (a build-time flag such as «this is the public demo», not a hardcoded hostname check spread through the UI).
- No new server routes, no new secrets, no changes to deploy scripts (`trialog-ops`, Vercel project ids).

## Tests

- A tight test (README and/or `docs/deploy.md`) that the button URL, when present, starts with `https://vercel.com/new/clone`, uses `repository-url` pointing at this repository, and lists the expected env-var names as prompts.
- The same test rejects any URL with a parameter outside an allow-list (repository-url, env, envDescription, project-name, integration/store params), so no ids, tokens, database URLs or billing params can slip in, without listing our ids in the public repo.
- If a demo-hub control is added: it renders on the demo build, stays a new-tab link to that URL, and does not render when the flag is off.
- No end-to-end test that actually creates a Vercel or Neon project.

## Estimate

About **2–3 hours** for the button, the docs wording, the URL tests, and a screenshot of the button in the README/docs (or on the demo). Closer to **half a day** if we also add a gated demo-hub control and carefully confirm it is absent on playground and live.

A docs-only pass is about **45–60 minutes**.

Risk that would stretch it: Vercel's Neon integration id or Deploy Button `stores=` / `integration-ids` param needs a live check against current Vercel docs, and we must not invent a shortcut that attaches our integration.

## Out of scope for that first build

- A hosted «provisioner» service.
- One-click custom domains, SSO, or billing plans.
- Changing how our playground or the live hub is deployed.
- Shipping this plan as a chat post; the owner reviews it first.
