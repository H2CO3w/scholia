# scholia
<img width="891" height="1247" alt="d35019320f84a010d09acb220d270156" src="https://github.com/user-attachments/assets/56de2efe-01fc-475c-87dc-9b103a8f43f3" />

*(package name `dsh-scholia`)*

**v0.1 — early and incomplete. Interfaces will change.**

A DSH plugin that turns a formalized theorem (Lean 4 / Mathlib) into something a
mathematician can actually read: a paper-style page with the statement rendered as
math, a proof outline, and annotations anchored to the formal objects.

Everything here is generated from a real corpus of Mathlib declarations plus
out-of-corpus Lean sources used as regression fixtures.

## What it produces

| Artifact | What it is |
|---|---|
| **Paper view** `out/render/*.html` | One page per theorem: rendered statement, Lean source, per-step annotations. Zero `<script>`. |
| **Main-line outline** `out/outline/<root>/index.html` | The proof's dependency cone reduced to a single ordered line of *steps*, each with the author's own one-sentence summary. |
| **Step pages** `out/outline/<root>/NN.html` | For one step: the modules it brings with it, each with its own summary. |
| **Dependency graph** `out/graph/*.svg` | The module-level import DAG, statically rendered. |

Start with `out/outline/Euler.Solution/index.html` and `out/render/CHSH_inequality_of_comm.html`.

## How the outline is built

The module graph alone is unreadable at 1829 nodes. What works is a **main line**:

- start from the module that declares the paper's theorem (taken from the source
  repo's `formalization.yaml`);
- at each step follow the dependency with the largest subtree;
- each step's *load* is the telescoping difference
  `|subtree(p_i)| - |subtree(p_{i+1})|`, which partitions the cone exactly —
  no overlaps, nothing missed.

Every module carries a `/-! ... -/` docstring written by whoever wrote the file,
so each step can be labelled with a sentence of mathematics instead of a file name.

Reading order is foundations-first (`--order reading`); the reverse is the raw
dependency order.

## Layout

```
src/core/     pure logic: skeleton extraction, anchors, graph, validation
src/io/       corpus streaming, SQLite lexicon index, artifacts, contract
src/render/   pure string generation: paper view, outline, graph, math
src/tools/    the DSH tools
scripts/      offline export scripts
vendor/katex/ vendored KaTeX (self-contained, server-side rendering)
docs/         SPEC / ARCHITECTURE / INTERFACES / USAGE (Chinese)
test/         incl. out-of-corpus Lean fixtures
out/          generated artifacts
```

## Requirements

Node.js 24+ (uses the built-in `node:sqlite`), Lean 4 sources if you want to
regenerate the graph/outline artifacts.

The corpus (`data/lsv2.jsonl`) and the lexicon index (`cache/lexicon.db`) are
**not** in this repo — they are hundreds of MB. See `docs/USAGE.md`.

## Status

- 360 tests, 0 failures.
- The paper view is the mature part; the outline and graph are newer (v1.4).
- Known limits are recorded in `docs/ARCHITECTURE.md` §11, including the
  Unicode→LaTeX gaps, the surface-syntax dependence of the skeleton extractor,
  and what the v1.3 "signature unknown" handling covers.

## License

MIT — see [LICENSE](LICENSE).

Bundled third-party material keeps its own license:

- `vendor/katex/` — KaTeX, MIT (see `vendor/katex/LICENSE` and `PROVENANCE.json`)
- `test/fixtures/lean/` — fragments from
  [openai/NavierStokesAndEuler](https://github.com/openai/NavierStokesAndEuler),
  Apache-2.0, attributed in each fixture header
