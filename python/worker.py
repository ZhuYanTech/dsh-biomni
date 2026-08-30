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
             "error": str|null, "truncated": bool, "outputChars": int}

``output`` is everything the code wrote to stdout/stderr, capped at
``MAX_OUTPUT_CHARS`` with ``outputChars`` carrying the true length so the
caller can say what was lost. ``value`` is the
repr of the final expression when the snippet ends in one, so a bare
``df.head()`` reads back like a REPL. ``error`` carries the formatted
traceback with this worker's own frames stripped.
"""

import ast
import json
import os
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

# The persistent namespace. Everything the agent defines accumulates here.
NAMESPACE = {"__name__": "__dsh_python__", "__builtins__": __builtins__}

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

    return {
        "output": output,
        "value": value,
        "error": error,
        "truncated": truncated,
        "outputChars": full_length,
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
        })


if __name__ == "__main__":
    main()
