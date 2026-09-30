# Stage: NOOP

This is a connectivity check for the worker, not real work. Do not use any tools.

Reply with exactly one fenced ```json block and nothing else, in this shape:

```json
{"ok": true, "echo": "<the message you were given>"}
```

`echo` must be the message from the task prompt, unchanged.
