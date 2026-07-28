# zen-hillclimb

Two panes, the same message: on the left what the app renders today, on the
right what Zen makes of it. Underneath, a box to say what's wrong.

```sh
bun run sql --refresh   # once, to extract the app's store to /tmp
bun run zen:dash        # http://localhost:4321
```

The corpus is real mail out of the app's own SQLite store. Hillclimbing a
converter on synthetic fixtures teaches you to convert synthetic fixtures; the
interesting cases are the ones nobody would think to write.

## The loop

1. Go through messages with `j`/`k`. Both panes are sandboxed iframes under the
   same content policy the app uses, so neither gets an unfair rendering.
2. Mark **good / meh / bad** and write what the conversion lost. `⌘⏎` saves.
3. The verdict lands in `annotations.jsonl` stamped with a hash of Zen's
   source.
4. Next session, Claude reads the bad verdicts at the current hash, fixes the
   rules those notes describe, and the hash changes. Verdicts left against
   older rules go hollow in the list — they're history, not a current
   judgement.

That hash is the whole point of the ledger. "The quote chain isn't collapsing"
against a build from three sessions ago is history; the same note against the
current rules is a bug.

## Reading the ledger

```sh
# what's still wrong, newest first
grep '"verdict":"bad"' packages/zen-hillclimb/annotations.jsonl | tail -20
```

Append-only on purpose: a message marked bad, then fixed, then marked good is
the record of a rule improving, and rewriting the earlier line would erase the
only evidence the change did anything.

## Notes

- The **source** button swaps the right pane for the raw markdown.
- Quoted regions render as collapsed `<details>`. That's the demonstration that
  the line ranges Zen reports are enough to build a reading UI on — if a region
  is off by a line, a sentence lands on the wrong side of the fold.
- A conversion that throws comes back as a result you can look at, not a 500.
  A crash on real mail is the most valuable thing this tool can find.
- Images are served from the app's own cached bytes, so neither pane calls out
  to the sender. An image the app never cached loads live, or breaks — which is
  honest about what the app would have to do too.
