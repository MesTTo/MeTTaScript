# @mettascript/fuzz

Property testing for [MeTTaScript](https://github.com/MesTTo/MeTTaScript), written in MeTTa. You declare
a generator and a property, and the library generates cases, shrinks a failure to its smallest form, and
hands back a result you can replay. It also enumerates small domains exhaustively, checks a real system
against a model over command sequences, and searches a transition relation for a reachable state.

The policy lives in MeTTa: generation, shrinking, the run loop, the state machines and the search are all
rewrite rules you can read in `src/metta`. TypeScript supplies only what a representation needs, in one
place: a splitmix/xoroshiro random source, a structural key over atoms, and a versioned atom codec.

## Install

```bash
npm install @mettascript/fuzz
```

Importing the package registers the `fuzz` module, so MeTTa code reaches it with `import!`.

## In one example

```metta
!(import! &self fuzz)

(: reverse-involution (-> Atom FuzzProperty))
(= (reverse-involution $xs)
   (expect-atom-equal (reverse (reverse $xs)) $xs))

!(fuzz-check reverse-involution
   (gen-list (gen-int -100 100) 0 40)
   reverse-involution
   (fuzz-config (Runs 200)))
```

A passing run reports what it did:

```text
(FuzzPassed (Property reverse-involution) (Seed 0)
  (FuzzStatistics (Counts (Passed 213) (PropertyDiscards 0) (GenerationDiscards 0)
    (Regressions 0) (Examples 0) (Edges 13) (Random 200)) ...))
```

`Runs` counts the random cases. Edge cases are drawn on top of them, which is why 200 runs report 213
passes here: the generator's boundary values are tried first, then the random ones.

Run a whole file of declared properties from the command line with `metta fuzz`:

```bash
metta fuzz properties.metta
```

## Where the documentation lives

- [Property testing](https://mestto.github.io/MeTTaScript/fuzz/overview) is the guide: writing a
  property, the generators, shrinking, exhaustive checking, state machines, and bounded reachability.
- [API reference](https://mestto.github.io/MeTTaScript/reference/fuzz) lists the full surface, including
  reading a result back from TypeScript.
- [The CLI](https://mestto.github.io/MeTTaScript/tools/cli) covers `metta fuzz` and `metta reach`.

## For language models

[`LLMS.md`](./LLMS.md) is a one-page, high-density reference for this package: API surface, working
examples, and the mistakes that produce wrong code. The repository root carries an
[`llms.txt`](../../llms.txt) index of all of them.

## License

[MIT](https://github.com/MesTTo/MeTTaScript/blob/main/LICENSE).
