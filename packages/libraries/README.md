<!--
SPDX-FileCopyrightText: 2026 MesTTo
SPDX-License-Identifier: MIT
-->

# @mettascript/libraries

`@mettascript/libraries` packages the pure MeTTa standard libraries for MeTTaScript.
Importing the package registers the modules with `@mettascript/core`, so programs
can load them with `(import! &self <name>)`.

```ts
import "@mettascript/libraries";
import { runProgram } from "@mettascript/core";

const out = runProgram(`
  !(import! &self vector)
  !(dot (1.0 2.0 3.0) (4.0 5.0 6.0))
`);
```

The package currently includes `vector`, `roman`, `combinatorics`, `patrick`,
`datastructures`, `spaces`, `nars`, and `pln`. The native host modules remain
in `@mettascript/core`.

## For language models

[`LLMS.md`](./LLMS.md) is a one-page, high-density reference for this package: API surface, working
examples, and the mistakes that produce wrong code. The repository root carries an
[`llms.txt`](../../llms.txt) index of all of them.
