// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Turns a MeTTa atom into a positioned tree of blocks, the way a projectional editor lays
// out an s-expression. Everything sits on a monospace grid: a character is one unit wide, a line one unit
// tall, and children in a row are separated by one unit. Most forms lay their children out in a row. The
// branching forms (`if`, `and`, `or`) and the binding forms (`=`, `let`, `match`, ...) instead stack,
// but only once their children grow past a small character cutoff, and the collecting forms (`case`,
// `superpose`, ...) stack with the head alone on the first line. A variable is drawn as a hole.
//
// The pass returns each block with local child positions and, for a stacked block, the right and left row
// profiles its backing follows. `placeProgram` then fixes absolute positions and stacks the program's
// heads down the canvas.

import {
  ExpressionAtom,
  VariableAtom,
  SymbolAtom,
  GroundedAtom,
  type Atom,
} from "@mettascript/hyperon";
import type { BlockSettings } from "./settings";
import type { ProfileRow } from "./geometry";
import { glyphColor, blockColors } from "./color";
import { displayGlyph } from "../color";

/** A leaf glyph. */
export interface AtomBox {
  kind: "atom";
  path: number[];
  x: number;
  y: number;
  w: number;
  h: number;
  depth: number;
  text: string;
  color: string;
}

/** A variable, drawn as a hole with its name inside. */
export interface HoleBox {
  kind: "hole";
  path: number[];
  x: number;
  y: number;
  w: number;
  h: number;
  depth: number;
  text: string;
}

/** A block: a form drawn as a backing with its head glyph and child boxes inside. */
export interface ExprBox {
  kind: "expr";
  path: number[];
  x: number;
  y: number;
  w: number;
  h: number;
  depth: number;
  orient: "h" | "v";
  fill: string;
  outline: string;
  headerException: boolean;
  children: BlockBox[];
  rightProfile: ProfileRow[];
  leftProfile: ProfileRow[];
}

export type BlockBox = AtomBox | HoleBox | ExprBox;

/** Branching forms: head and first argument on line one, the rest indented below. */
const IF_LIKE = new Set(["if", "and", "or"]);
/** Binding and abstraction forms, including the `|->` lambda: head and first argument on line one. */
const LAMBDA_LIKE = new Set([
  "=",
  "let",
  "let*",
  "match",
  "function",
  "lambda",
  "|->",
  "sealed",
  "chain",
]);
/** Collecting forms: head alone on line one, everything indented under it. */
const COND_LIKE = new Set(["case", "cond", "superpose", "collapse", "unify"]);

interface FormClass {
  headerItems: number;
  indent: number;
  straightLeft: boolean;
  headerException: boolean;
}

/** Classify a head name into a stacking form, or null when the form never stacks. `firstArgWidth` sets
 *  the branching indent so the branches line up under the first argument. */
function classify(head: string, u: number): FormClass | null {
  // Flush-left (straight-left) in every case: the backing's left edge stays at zero and only the right
  // edge steps to each row's content, which reads as a clean indented outline rather than a nub that is
  // pinched in on both sides.
  // Indent the body one unit, so it lines up just under the head rather than drifting to the right.
  if (IF_LIKE.has(head))
    return { headerItems: 2, indent: u, straightLeft: true, headerException: false };
  if (LAMBDA_LIKE.has(head))
    return { headerItems: 2, indent: u, straightLeft: true, headerException: true };
  if (COND_LIKE.has(head))
    return { headerItems: 1, indent: u, straightLeft: true, headerException: false };
  return null;
}

/** Whether `atom` heads a `(name child...)` form (an atomic head with at least one argument). */
function isHeaded(atom: ExpressionAtom): boolean {
  const items = atom.children();
  const head = items[0];
  return items.length >= 2 && head !== undefined && isLeaf(head);
}

function isLeaf(atom: Atom): boolean {
  return atom instanceof SymbolAtom || atom instanceof VariableAtom || atom instanceof GroundedAtom;
}

/** A bare atom or hole wants a unit of right padding so its backing does not clip the last glyph. */
function needsTail(box: BlockBox): boolean {
  return box.kind !== "expr";
}

/** Lay boxes out in a row starting at `startX`, one unit apart, top-aligned. Returns the right extent and
 *  the row height. */
function layoutRow(boxes: BlockBox[], startX: number, u: number): { right: number; h: number } {
  let x = startX;
  let h = 0;
  let right = startX;
  for (const b of boxes) {
    b.x = x;
    b.y = 0;
    right = x + b.w;
    h = Math.max(h, b.h);
    x = right + u;
  }
  return { right, h };
}

/** Build a block and its subtree with child positions local to the block's top-left. */
function build(
  atom: Atom,
  depth: number,
  path: number[],
  isHead: boolean,
  s: BlockSettings,
): BlockBox {
  const u = s.unitWidth;
  if (atom instanceof VariableAtom) {
    const text = atom.toString();
    return {
      kind: "hole",
      path,
      x: 0,
      y: 0,
      w: text.length * u + u, // a half unit of breathing room on each side of the name
      h: s.unitHeight,
      depth,
      text,
    };
  }
  if (!(atom instanceof ExpressionAtom)) {
    const name = atom.toString();
    const text = displayGlyph(name); // draw the math glyph; color by the original name
    return {
      kind: "atom",
      path,
      x: 0,
      y: 0,
      w: text.length * u,
      h: s.unitHeight,
      depth,
      text,
      color: glyphColor(name, isHead, s),
    };
  }

  const items = atom.children();
  if (items.length === 0) {
    // An empty expression () is a value (the empty list), not a container. Lay it out as a labeled pill
    // sized to its "()" glyph so it reads inline like any other leaf, instead of the zero-height backing
    // (w = u, h = 0) that a childless row produces and that surfaces as a stray dot.
    const { fill, outline } = blockColors(depth, s);
    const w = 3 * u; // "()" is two glyphs, with a half unit of breathing room each side, like a hole
    const h = s.unitHeight;
    return {
      kind: "expr",
      path,
      x: 0,
      y: 0,
      w,
      h,
      depth,
      orient: "h",
      fill,
      outline,
      headerException: false,
      children: [],
      rightProfile: [{ x: w, h }],
      leftProfile: [{ x: 0, h }],
    };
  }
  const headed = isHeaded(atom);
  const children: BlockBox[] = items.map((child, k) => {
    const childIsHead = headed && k === 0;
    return build(child, childIsHead ? depth : depth + 1, [...path, k], childIsHead, s);
  });

  const { fill, outline } = blockColors(depth, s);
  const totalChars = children.reduce((sum, b) => sum + b.w, 0) / u;
  const headName = headed ? items[0]!.toString() : "";
  const cls = headed && children.length >= 2 ? classify(headName, u) : null;
  const stacks = cls !== null && totalChars >= s.cutoff && children.length > cls.headerItems;

  if (!stacks) {
    const { right, h } = layoutRow(children, u, u);
    const last = children[children.length - 1];
    const w = right + (last !== undefined && needsTail(last) ? u : 0);
    return {
      kind: "expr",
      path,
      x: 0,
      y: 0,
      w,
      h,
      depth,
      orient: "h",
      fill,
      outline,
      headerException: false,
      children,
      rightProfile: [{ x: w, h }],
      leftProfile: [{ x: 0, h }],
    };
  }

  const c = cls!;
  const header = children.slice(0, c.headerItems);
  const body = children.slice(c.headerItems);
  const head = layoutRow(header, u, u);
  const lastHeader = header[header.length - 1];
  const rightProfile: ProfileRow[] = [
    { x: head.right + (lastHeader !== undefined && needsTail(lastHeader) ? u : 0), h: head.h },
  ];
  const leftProfile: ProfileRow[] = [{ x: 0, h: head.h }];
  let yCursor = head.h;
  for (const b of body) {
    b.x = c.indent;
    b.y = yCursor;
    yCursor += b.h;
    rightProfile.push({ x: c.indent + b.w + (needsTail(b) ? u : 0), h: b.h });
    leftProfile.push({ x: c.straightLeft ? 0 : c.indent, h: b.h });
  }
  const w = Math.max(...rightProfile.map((r) => r.x));
  return {
    kind: "expr",
    path,
    x: 0,
    y: 0,
    w,
    h: yCursor,
    depth,
    orient: "v",
    fill,
    outline,
    headerException: c.headerException,
    children,
    rightProfile,
    leftProfile,
  };
}

/** Shift a box and its subtree to absolute coordinates. Child positions are local to their parent, so a
 *  child's absolute origin is the parent's absolute origin plus the child's local offset. */
function place(box: BlockBox, ox: number, oy: number): void {
  box.x += ox;
  box.y += oy;
  if (box.kind === "expr") for (const child of box.children) place(child, box.x, box.y);
}

/** Lay out one atom as a block tree rooted at the origin. */
export function layoutAtom(atom: Atom, s: BlockSettings, path: number[] = []): BlockBox {
  const box = build(atom, 0, path, false, s);
  place(box, 0, 0);
  return box;
}

/** Lay out a whole program: one block per head, stacked down the canvas with a gap between them. Each
 *  head keeps its index as its root path so a reduction can be spliced back into the right head. */
export function placeProgram(atoms: readonly Atom[], s: BlockSettings): BlockBox[] {
  const gap = s.unitHeight;
  const boxes: BlockBox[] = [];
  let y = 0;
  for (let i = 0; i < atoms.length; i++) {
    const box = build(atoms[i]!, 0, [i], false, s);
    place(box, 0, y);
    boxes.push(box);
    y += box.h + gap;
  }
  return boxes;
}
