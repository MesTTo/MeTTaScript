<!--
SPDX-FileCopyrightText: 2026 MesTTo
SPDX-License-Identifier: MIT
-->

# @mettascript/debug

`@mettascript/debug` contains the host-free debugger engine used by `metta-debug`
and embedders such as language servers.

The package does not read files, register global output sinks, or import Node
APIs. Callers provide the exact runner they already use.

```ts
import { explainCall } from "@mettascript/debug";
import { runProgram } from "@mettascript/core";

const report = explainCall(runProgram, "(= (double $x) (* $x 2))", "(double 21)");

console.log(report.result); // ["42"]
```

Use `collectTrace` when the caller already has an assembled program and only
needs the raw trace event stream. Use `summarize` when the caller already
collected events and needs the grouped `metta-debug why` counters.

## For language models

[`LLMS.md`](./LLMS.md) is a one-page, high-density reference for this package: API surface, working
examples, and the mistakes that produce wrong code. The repository root carries an
[`llms.txt`](../../llms.txt) index of all of them.
