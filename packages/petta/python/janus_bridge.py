# SPDX-FileCopyrightText: 2026 MesTTo
#
# SPDX-License-Identifier: MIT

# Purpose: the Python half of the petta engine's janus bridge (src/janus.ts): one JSON request per line on the
# request FIFO, one JSON answer per line on the answer FIFO. A request is a janus call chain (Module:Func(Args),
# Obj:Method(Args), Module:Attr, chained); values cross as janus converts them (SWI-Prolog's library(janus)):
# int, float, str, bool, None, list, tuple, dict and set by value, any other object as a reference kept in a
# table. Output the call prints is captured and returned, so the engine emits it in order with its own.
# am[implements a-hp-janus]

import importlib
import io
import json
import math
import sys
import traceback

objects = {}
ids = {}
next_id = 1


def ref(obj):
    """The table id of an object, the same id for the same object."""
    global next_id
    key = id(obj)
    found = ids.get(key)
    if found is not None and objects.get(found) is obj:
        return found
    oid = next_id
    next_id += 1
    objects[oid] = obj
    ids[key] = oid
    return oid


def decode(v):
    """A Prolog value as janus passes it to Python."""
    t = v["t"]
    if t == "int":
        return int(v["v"])
    if t == "float":
        x = v["v"]
        if x == "inf":
            return math.inf
        if x == "-inf":
            return -math.inf
        if x == "nan":
            return math.nan
        return float(x)
    if t == "str":
        return v["v"]
    if t == "bool":
        return bool(v["v"])
    if t == "none":
        return None
    if t == "list":
        return [decode(x) for x in v["v"]]
    if t == "tuple":
        return tuple(decode(x) for x in v["v"])
    if t == "set":
        return set(decode(x) for x in v["v"])
    if t == "dict":
        return {decode(k): decode(x) for k, x in v["v"]}
    if t == "ref":
        return objects[v["v"]]
    raise ValueError("cannot decode %r" % (v,))


def encode(x):
    """A Python value as janus returns it to Prolog."""
    if isinstance(x, bool):
        return {"t": "bool", "v": x}
    if isinstance(x, int):
        return {"t": "int", "v": str(x)}
    if isinstance(x, float):
        if math.isinf(x):
            return {"t": "float", "v": "inf" if x > 0 else "-inf"}
        if math.isnan(x):
            return {"t": "float", "v": "nan"}
        return {"t": "float", "v": repr(x)}
    if isinstance(x, str):
        return {"t": "str", "v": x}
    if x is None:
        return {"t": "none"}
    if isinstance(x, list):
        return {"t": "list", "v": [encode(e) for e in x]}
    if isinstance(x, tuple):
        return {"t": "tuple", "v": [encode(e) for e in x]}
    if isinstance(x, dict):
        return {"t": "dict", "v": [[encode(k), encode(e)] for k, e in x.items()]}
    if isinstance(x, (set, frozenset)):
        return {"t": "set", "v": [encode(e) for e in x]}
    if isinstance(x, (bytes, bytearray)):
        return {"t": "list", "v": [{"t": "int", "v": str(b)} for b in x]}
    return {"t": "ref", "v": ref(x), "type": type(x).__name__}


def run_chain(steps):
    """Evaluate a janus call chain left to right: a module or object root, then attributes and calls."""
    root = steps[0]
    if "mod" in root:
        cur = importlib.import_module(root["mod"])
    else:
        cur = decode(root["obj"])
    for st in steps[1:]:
        if "attr" in st:
            cur = getattr(cur, st["attr"])
        else:
            fn = getattr(cur, st["call"])
            args = [decode(a) for a in st["args"]]
            kwargs = {k: decode(v) for k, v in st["kwargs"]}
            cur = fn(*args, **kwargs)
    return cur


def main(req_path, resp_path):
    req = open(req_path, "r", encoding="utf-8")
    resp = open(resp_path, "w", encoding="utf-8")
    real_out, real_err = sys.stdout, sys.stderr
    for line in req:
        msg = json.loads(line)
        out, err = io.StringIO(), io.StringIO()
        sys.stdout, sys.stderr = out, err
        try:
            if msg["op"] == "call":
                answer = {"ok": encode(run_chain(msg["chain"]))}
            elif msg["op"] == "free":
                objects.pop(msg["id"], None)
                answer = {"ok": {"t": "none"}}
            else:
                answer = {"err": {"type": "ValueError", "ref": ref(ValueError(msg["op"]))}}
        except BaseException as e:  # a Python error becomes janus's python_error(Type, Exception)
            answer = {"err": {"type": type(e).__name__, "ref": ref(e), "text": "".join(traceback.format_exception_only(type(e), e)).strip()}}
        finally:
            sys.stdout, sys.stderr = real_out, real_err
        answer["out"] = out.getvalue()
        answer["errout"] = err.getvalue()
        resp.write(json.dumps(answer) + "\n")
        resp.flush()


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
