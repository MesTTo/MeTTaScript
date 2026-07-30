<!--
SPDX-FileCopyrightText: 2026 MesTTo
SPDX-License-Identifier: MIT
-->

# The metta CLI

`@mettascript/node` installs the `metta` command. Use it to run MeTTa files, check them, explain reductions, render reduction GIFs, and run property tests.

```bash
npm install -g @mettascript/node
```

## Run a program

```bash
metta run hello.metta
metta hello.metta
```

Both commands run the file and print one result list for each `!` query:

```metta
(= (double $x) (* $x 2))
!(double 21)
```

```text
[42]
```

`metta <file.metta>` is shorthand for `metta run <file.metta>`.

The runner accepts these flags:

| flag                  | does                                                         |
| --------------------- | ------------------------------------------------------------ |
| `--check`             | run static analysis instead of evaluation                    |
| `--json`              | print checker diagnostics as JSON when `--check` is set      |
| `--undefined-symbols` | include undefined-symbol diagnostics in the checker          |
| `--py`                | enable Python interop through `pythonia`                     |
| `--prolog`            | enable Prolog interop through a local `swipl` executable     |
| `--conformance`       | print every top-level directive result, not only `!` queries |
| `--max-steps=N`       | set the evaluation fuel                                      |
| `--max-stack-depth=N` | set the initial interpreter stack-depth bound                |
| `--hash-cons`         | enable the experimental hash-consing mode                    |
| `--flat-atomspace`    | enable the experimental flat atomspace mode                  |

Host runtimes are opt-in. Without `--py` or `--prolog`, the runner does not load Python, Prolog, or their optional packages.

## Check a program

```bash
metta check hello.metta
metta check hello.metta --json --undefined-symbols
```

`metta check` runs the same static analyzer as `metta run --check`. Human diagnostics are printed to stderr. JSON diagnostics are printed to stdout.

## Debug the engine

```bash
metta debug --source '(= (double $x) (* $x 2))' eval '(double 21)'
metta debug --source '!(+ 1 2)' run
metta debug --file program.metta why '(main)' --llm --max-steps 1000
```

The debugger takes source from `--file <p>` or `--source '<m>'`, then runs one command:

| command | does                                                         |
| ------- | ------------------------------------------------------------ |
| `why`   | evaluates one call with tracing and prints the trace summary |
| `eval`  | evaluates one expression against the loaded source           |
| `run`   | runs every `!` query in the loaded source                    |

`--llm` prints JSON. `--max-steps N` sets the evaluation fuel. See [Debugging and traces](/tools/metta-debug) for the trace fields.

## Run property tests

```bash
metta fuzz suite.metta
metta fuzz --list suite.metta
metta fuzz --seed 7 --runs 50 suite.metta
metta fuzz --exhaustive suite.metta
metta fuzz --corpus regressions suite.metta
metta reach suite.metta [id]
```

`metta fuzz` runs every `(FuzzTest ...)` declaration a file carries and prints one line each. `metta reach` does the same for `(FuzzReachTest ...)`, optionally restricted to one id. Neither runs the file's own `!` queries: reading a suite is not a way to execute whatever else the file would have done. `import!` and `register-module!` are kept, because a property defined in an imported file would be undefined without them.

| option | does |
| ------ | ---- |
| `--list` | prints the declarations without running them |
| `--json` | prints the full result atoms as one JSON document on stdout |
| `--exhaustive` | enumerates each declaration's whole domain instead of sampling |
| `--corpus <dir>` | replays the counterexamples stored there first, and records new ones |
| `--no-record` | reads the corpus without writing to it |
| `--seed`, `--runs`, `--max-size`, `--max-discards`, `--max-shrinks`, `--case-steps`, `--case-depth`, `--max-enumerated` | replace that option in every declaration's `fuzz-config` |
| `--max-depth`, `--max-states`, `--max-transitions` | replace that option in every `reach-config`, for `metta reach` |

The exit code is the run's verdict, so the command works as a test gate:

| code | means |
| ---- | ----- |
| 0 | every declaration passed, or gave a definitive answer |
| 1 | a property failed |
| 2 | invalid input, or corrupt stored data |
| 3 | an incomplete run: gave up, bounded by depth, or cut off by a limit |

Results go to stdout and diagnostics to stderr, so `--json` prints exactly one document however much the run has to say about its corpus. See [Property testing](/fuzz/overview) for how to write the declarations.

## Render a reduction GIF

```bash
metta graph program.metta -o out.gif
metta graph program.metta --view side-by-side --width 960 --max-steps 200
```

`metta graph` renders the reduction to an animated GIF through `@mettascript/grapher/node`. The grapher is loaded lazily, so install the renderer packages before using this command:

```bash
npm install @mettascript/grapher gifenc sharp
```

The graph command accepts these flags:

| flag                  | does                                           |
| --------------------- | ---------------------------------------------- |
| `-o out.gif`          | write to the given GIF path                    |
| `--view blocks`       | render the nested blocks view                  |
| `--view graph`        | render the node graph view                     |
| `--view side-by-side` | render both views together                     |
| `--width N`           | set the GIF width in pixels                    |
| `--max-steps N`       | bound reduction steps while building the trace |

## Version and help

```bash
metta --version
metta --help
```

`metta-ts` remains an alias for `metta run`, and `metta-debug` remains an alias for `metta debug`.

The Python Hyperon package also installs a `metta` executable, so if both are on `PATH`, whichever comes first shadows the other. Use the `metta-ts` alias to reach this runner when that happens.
