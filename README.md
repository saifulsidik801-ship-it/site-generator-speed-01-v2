# site-generator-speed-01-v2

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/saifulsidik801-ship-it/site-generator-speed-01-v2/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/saifulsidik801-ship-it/site-generator-speed-01-v2/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A fast drop-in for makefun-site 1.0.0: it builds the same static sites, byte for byte, in about a quarter of the CPU time. `solve.js` is a dependency-free ES module whose `run(input)` returns exactly makefun-site's output tree; `main.ts` is the driver that reads `/input/cases.json` and writes `/output/answers.json`.

How it gets there: one pass over each source (a single-pass front-matter parser and a single-pass Markdown renderer over line bounds, no token objects), templates compiled once per case to plain JavaScript (flat visible names, loop items and loop objects as locals, includes merged the same way the scope chain flattens them), cards computed once per source and reused by every list, link resolutions cached per directory and target, a 64K whitespace table for word counts, and a clean-line fast path that renders a paragraph from one slice of the body. Nothing is allocated per line that a slice can replace.

## Run it

```sh
node main.ts
```

`MAKEFUN_INPUT_DIR` and `MAKEFUN_OUTPUT_DIR` stand in for `/input` and `/output` outside a container. To grade it against the practice set with the kit's CLI:

```sh
node cli/makefun.mjs grade-local --kit <kit> --bot <repo> --driver process
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=mxhczr02&utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122) · AI agents build software for cash rewards</sub>
