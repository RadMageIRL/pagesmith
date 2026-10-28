# Changelog

All notable changes to PageSmith are recorded here. Versions follow [Semantic Versioning](https://semver.org/).

## [0.2.0] - Unreleased

The first public version. An earlier 0.1 milestone (open and preview, page organizing, merge, split and extract, overlays, local-only processing) was developed and tested locally and never published; everything it contained is part of this release.

### Open and preview
- Open PDFs by drag-and-drop, the file picker, or (once installed) "Open with" PageSmith.
- Thumbnail sidebar, continuous preview, fit-width, fit-page, 100% and zoom steps.
- Page jump (Ctrl+G) and PgUp/PgDn/Home/End navigation.
- Text search (Ctrl+F) with highlighted hits. Pages without a text layer are detected and reported.
- Password-protected PDFs (RC4-40, RC4-128, AES-128, AES-256) open after the password is entered. Files that only carry owner restrictions open after the user confirms they have the right to modify them. Passwords are never stored.

### Organize
- Reorder pages by dragging thumbnails with a mouse, by long-press-and-drag on touch screens, with Alt+Up/Down, or with Move up/down.
- Rotate, delete and multi-select pages (Ctrl/Cmd-click, Shift-click, Ctrl+A).
- Insert blank pages matching the current page, or Letter, Legal, A3, A4, A5 or Tabloid in portrait or landscape.
- Undo and redo for every page and overlay change.

### Merge, split, extract
- Merge PDFs with mixed page sizes and reorder pages across files.
- Extract selected pages; split by ranges (`1-3, 5, 8-`) or every N pages.
- Splits that produce several files download as one ZIP.
- Long builds show progress and can be canceled.

### Overlays
- Text, signature images (PNG/JPEG), highlights and boxes.
- Overlays can be moved, resized, recolored, edited, duplicated and deleted after placing them.
- Text uses the bundled Noto Sans font on screen and in the export (Latin, Greek, Cyrillic, Vietnamese). Characters the font can't draw are flagged before export.
- Overlays stay attached to their page through reordering and rotation.

### App
- All PDF processing runs locally, in Web Workers, so large documents don't freeze the page.
- Installable PWA that works offline after the first visit. Updates wait for the user to click Reload.
- Light, dark and system themes, a keyboard shortcut list (`?`), and a responsive layout for tablets and phones.
- The About dialog links to the license, the third-party notices and the source code. The license and notices ship with the app and work offline.
- pdf.js's scripting sandbox is not shipped: PageSmith never runs scripts embedded in a PDF.
- A Content-Security-Policy in the production build keeps every request on the app's own origin.
