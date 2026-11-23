# Vento

A web app for laying out photo albums and downloading every sheet at **300 dpi**, ready for the print shop.

**Open it:** https://lcscarvalho.github.io/vento/

## What it does

- **Sheet format** — ready-made sizes (10 × 15, 15 × 21, A4, 30 × 30, 10 × 50…) or any size in cm, portrait or landscape.
- **Multiple sheets**, side by side or stacked. A photo can run across from one sheet to the next: on export it is cut into each sheet at its exact position.
- **Background** picked from a colour wheel (white by default), with the brand colours one click away.
- **High-resolution images** — the original file is never recompressed. On screen the app uses a light preview; on export it draws from the original.
- **Keep aspect ratio** or **free aspect ratio**: with the lock off, the frame crops the photo (no distortion) and a double-click lets you reframe it.
- **Effective dpi** of each image at its current size, so you know whether it will print sharp.
- **Download** as JPG (quality 95) or PNG, with 300 dpi written into the file. More than one sheet comes in a `.zip`.
- The album is saved in your own browser (IndexedDB) — nothing is sent to any server.

## Shortcuts

| Key | Action |
| --- | --- |
| `Delete` | remove the image |
| `⌘D` | duplicate |
| `⌘Z` / `⇧⌘Z` | undo / redo |
| arrows | nudge 1 mm (`⇧` 10 mm) |
| `⇧` while resizing | flip the aspect-ratio lock |
| `⌥` while dragging | turn off snapping |
| `⌘` + scroll | zoom |
| double-click | reframe (with free aspect ratio) |
| `L` | lock / unlock the aspect ratio |
| `[` `]` | send to back / bring to front |

## Development

No build step: plain HTML, CSS and JavaScript (ES modules). To run locally:

```bash
python3 -m http.server 8000
```

then open http://localhost:8000.
