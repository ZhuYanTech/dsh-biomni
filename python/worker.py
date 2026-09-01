#!/usr/bin/env python3
"""Persistent Python worker driven over newline-delimited JSON on stdio.

One worker serves one agent for its whole session: every request executes in
the same module namespace, so imports, dataframes, and fitted models defined
in one call stay available to the next. This mirrors Biomni's
``run_python_repl`` persistent-namespace model, but speaks a framed protocol
instead of being called in-process.

Protocol, one JSON object per line in each direction:

  request   {"id": str, "code": str}
  response  {"id": str, "ok": bool, "output": str, "value": str|null,
             "error": str|null, "truncated": bool, "outputChars": int,
             "artifacts": [{"name": str, "bytes": int, "action": str}]}

``output`` is everything the code wrote to stdout/stderr, capped at
``MAX_OUTPUT_CHARS`` with ``outputChars`` carrying the true length so the
caller can say what was lost. ``value`` is the
repr of the final expression when the snippet ends in one, so a bare
``df.head()`` reads back like a REPL. ``error`` carries the formatted
traceback with this worker's own frames stripped.

``artifacts`` names the files the snippet wrote into the session's output
directory. Results that are not text have nowhere else to go: printing a plot
is impossible and printing a big table is capped, so before this the only
honest answer was "it is somewhere on disk". The directory is bound in the
namespace as ``BIOMNI_OUT`` and reported back per call, which costs nothing on
the calls that write nothing.
"""

import ast
import json
import os
import pathlib
import sys
import tempfile
import traceback

# Claim a private channel for protocol frames before running anything the
# model wrote. User code — including C extensions that write straight to the
# file descriptor rather than through sys.stdout — is redirected away from it
# on every execution, so no amount of printing can corrupt the framing.
_PROTOCOL = os.fdopen(os.dup(1), "w", encoding="utf-8", buffering=1)
_NULL_FD = os.open(os.devnull, os.O_WRONLY)
os.dup2(_NULL_FD, 1)

#: Where the agent is told to put results. Passed by the host so the plugin and
#: the worker cannot disagree about the location; created lazily, because a
#: session that never writes anything should not leave an empty directory in
#: someone's workspace.
OUT_DIR = pathlib.Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else pathlib.Path.cwd()

# The persistent namespace. Everything the agent defines accumulates here.
#
# BIOMNI_OUT is bound rather than only documented: a path the model has to
# reconstruct from prose is a path it will get wrong, and then the file lands
# somewhere nothing reports on.
NAMESPACE = {
    "__name__": "__dsh_python__",
    "__builtins__": __builtins__,
    "BIOMNI_OUT": OUT_DIR,
}

#: Most files a call is expected to produce. A loop that writes thousands is a
#: mistake worth naming rather than a list worth rendering in full.
MAX_ARTIFACTS = 20

#: Character cap on one call's captured output.
#:
#: This is a CONTEXT budget, not a memory one. Whatever survives here is pasted
#: straight into the model's next request, and 200_000 characters — the value
#: this started at — is roughly 50k tokens: one stray `print(df)` on a real
#: dataframe would evict most of a session's working context to show a table
#: nobody reads past the tenth row.
#:
#: 16_000 is about 4k tokens: enough for a head(), a describe(), a stack trace,
#: or a few hundred lines of log, and small enough that hitting it is a nudge
#: rather than a catastrophe. The truncation notice says how to get the rest.
MAX_OUTPUT_CHARS = 16_000


def _snapshot():
    """{relative name: (size, mtime_ns)} for the output tree, or {} when absent.

    Recursive, so a call that writes into a subdirectory is still reported.
    Never raises: an unreadable output directory must not fail the execution
    that happened to run beside it.

    Symlinks are skipped, and that is the same rule the operator side applies:
    the listing walks with dirent types and the download route compares real
    paths, so a link out of this directory is refused there. Reporting one here
    would tell the model it produced a file nobody can fetch — the exact shape
    of claim this plugin exists to prevent.
    """
    if not OUT_DIR.is_dir():
        return {}
    out = {}
    try:
        for path in OUT_DIR.rglob("*"):
            try:
                if path.is_symlink() or not path.is_file():
                    continue
                stat = path.stat()
                out[str(path.relative_to(OUT_DIR))] = (stat.st_size, stat.st_mtime_ns)
            except OSError:
                continue
    except OSError:
        return {}
    return out


def _artifacts(before, after):
    """What changed between two snapshots, newest first.

    Only additions and modifications. A deletion is not a result, and reporting
    it would turn tidying up into noise.
    """
    changed = []
    for name, (size, mtime) in after.items():
        prior = before.get(name)
        if prior is None:
            changed.append((mtime, {"name": name, "bytes": size, "action": "wrote"}))
        elif prior != (size, mtime):
            changed.append((mtime, {"name": name, "bytes": size, "action": "updated"}))
    changed.sort(key=lambda item: -item[0])
    return [entry for _, entry in changed[:MAX_ARTIFACTS]], len(changed)


def _send(payload):
    _PROTOCOL.write(json.dumps(payload, ensure_ascii=False) + "\n")
    _PROTOCOL.flush()


def _split_last_expression(code):
    """Split a snippet into (statements, trailing expression or None).

    Returns compiled code objects. A trailing expression is compiled in
    ``eval`` mode so its value can be reported like an interactive REPL.
    """
    tree = ast.parse(code)
    if tree.body and isinstance(tree.body[-1], ast.Expr):
        head = ast.Module(body=tree.body[:-1], type_ignores=[])
        tail = ast.Expression(body=tree.body[-1].value)
        return compile(head, "<dsh>", "exec"), compile(tail, "<dsh>", "eval")
    return compile(tree, "<dsh>", "exec"), None


def _format_error(exc):
    """Format a traceback without this worker's own frames.

    The model should see only the frames from the code it wrote; the worker's
    dispatch frames are noise that invites it to "fix" our file.
    """
    entries = traceback.extract_tb(exc.__traceback__)
    user_frames = [frame for frame in entries if frame.filename == "<dsh>"]
    lines = ["Traceback (most recent call last):\n"]
    lines.extend(traceback.format_list(user_frames))
    lines.extend(traceback.format_exception_only(type(exc), exc))
    return "".join(lines)


def _execute(code):
    """Run one snippet with stdout/stderr captured at the descriptor level."""
    before = _snapshot()
    saved_stdout, saved_stderr = sys.stdout, sys.stderr
    saved_out_fd, saved_err_fd = os.dup(1), os.dup(2)

    with tempfile.TemporaryFile(mode="w+", encoding="utf-8", errors="replace") as capture:
        # Both halves are needed: dup2 catches extensions writing to the raw
        # descriptor, the sys rebinding catches Python-level buffered writes
        # that would otherwise flush after we have already read the file.
        os.dup2(capture.fileno(), 1)
        os.dup2(capture.fileno(), 2)
        sys.stdout = sys.stderr = capture

        value = None
        error = None
        try:
            statements, expression = _split_last_expression(code)
            exec(statements, NAMESPACE)
            if expression is not None:
                result = eval(expression, NAMESPACE)
                if result is not None:
                    value = repr(result)
        except BaseException as exc:  # noqa: BLE001 - reported, never raised
            error = _format_error(exc)
        finally:
            try:
                capture.flush()
            except ValueError:
                pass
            sys.stdout, sys.stderr = saved_stdout, saved_stderr
            os.dup2(saved_out_fd, 1)
            os.dup2(saved_err_fd, 2)
            os.close(saved_out_fd)
            os.close(saved_err_fd)

        capture.seek(0)
        output = capture.read()

    full_length = len(output)
    truncated = full_length > MAX_OUTPUT_CHARS
    if truncated:
        # Keep the HEAD: a traceback's own message is at the end, but that
        # travels in `error`, while a truncated listing is only useful from
        # the top.
        output = output[:MAX_OUTPUT_CHARS]

    # After the capture is torn down, so a slow flush cannot be mistaken for a
    # file the snippet wrote.
    artifacts, total = _artifacts(before, _snapshot())

    return {
        "output": output,
        "value": value,
        "error": error,
        "truncated": truncated,
        "outputChars": full_length,
        "artifacts": artifacts,
        "artifactCount": total,
    }


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except ValueError:
            continue

        request_id = request.get("id")
        code = request.get("code", "")

        result = _execute(code)
        _send({
            "id": request_id,
            "ok": result["error"] is None,
            "output": result["output"],
            "value": result["value"],
            "error": result["error"],
            "truncated": result["truncated"],
            "outputChars": result["outputChars"],
            "artifacts": result["artifacts"],
            "artifactCount": result["artifactCount"],
        })


if __name__ == "__main__":
    main()
