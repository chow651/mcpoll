# Contributing

Small project, two rules: keep the claims measurable, and keep the blast radius small.

## The one design rule

**If it cannot be measured from what is already on disk, it is not shown.**

There is no default coefficient, no "estimated" badge, no plausible-looking placeholder. A host whose log
lacks tool definitions shows call counts and dashes. PRs that add estimates to fill a gap will be declined;
PRs that add a *measurement* are very welcome.

## Good first contributions

- **More log formats.** Any agent that records both tool definitions and token counts. Add a scanner in
  `lib/usage.mjs`, a host adapter in `lib/hosts.mjs`, and a row in the README support table.
- **English UI.** Every string is inline in `ui/app.js` and `ui/index.html`. A `ui/i18n.js` with a settings
  toggle (default: follow the OS locale) would unlock a lot of users.
- **A calibration across model families.** `bin/calibrate.mjs` measures one host at a time; recording the
  factor for GPT / Gemini / Claude / DeepSeek backends as a table would make the defaults less author-shaped.
- **macOS / Linux smoke tests.** The code paths exist but the author only runs Windows.

## Before you open a PR

```bash
node --check bin/ui.mjs && node --check lib/ledger.mjs   # syntax
npm run ui                                              # does the panel still render?
node bin/tax.mjs                                        # do the numbers still add up?
```

If you change the way anything is priced, say in the PR **what you measured it against**. A number without
a method is a guess with a decimal point.

## Reporting a wrong number

Include the host, the server, what mcpoll says, and the log line you think it disagrees with. Log excerpts
are usually enough — strip anything private first.
