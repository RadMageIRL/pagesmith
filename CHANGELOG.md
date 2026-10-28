# Changelog

All notable changes to PageSmith are recorded here. Versions follow [Semantic Versioning](https://semver.org/).

## [0.2.1] - 2026-10-27

The first web release, at radmagelabs.com/pagesmith/.

### Security
- **Upgrade from 0.2.0 recommended.** In 0.2.0, exporting only some pages (extract, split, or export after deleting pages) could carry pages you left out inside the new file. When a page you kept had a link or a go-to action pointing at a left-out page, a form field shared with one, or a comment replying to a comment on one, the left-out page came along as a hidden object: its text and images, its comments, files attached to it, and form values on it. A viewer doesn't show it, but anyone who inspects the file can recover it. 0.2.1 cuts every such reference and drops whatever is no longer reachable. Tests check exported files object by object, with two independent readers, for markers that exist only on the left-out page. This is not a general redaction tool: everything on the pages you keep stays in the file.

### Fixed
- Fillable forms keep working in exports. Before, every export, even of a single unchanged file, lost the form, so its fields could no longer be filled in. Merged files keep separate fields: a clashing name gets a suffix (`name_2`).
- Links between exported pages land on the right page, in any page order.
- On phones, the update notice no longer covers the toolbar, and WebKit, the engine behind Safari, no longer counts the closed drawers as page width.

### Added
- Opening an XFA form or a digitally signed PDF says what an export can't keep.
- Search and sharing details for radmagelabs.com/pagesmith/: title, description, canonical address, preview image and structured data. The About dialog links to RadMage Labs.
- THIRD-PARTY-NOTICES.txt is generated from the lockfile, and the build refuses an out-of-date copy.
- A GitHub Pages deployment workflow that only runs when started by hand.
- Browser tests in Firefox and WebKit (`npm run test:engines`), and checks of the app running under `/pagesmith/`.

### Changed
- The service worker's version comes from the package version and the built files only, so the same sources always build identical files.

## [0.2.0] - 2026-10-27

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
