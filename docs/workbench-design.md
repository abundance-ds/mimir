# Workbench Design Direction

This document adapts the existing design system to the Sidebar / Activity /
Editor product in [synthesis.md](synthesis.md). It defines the visual thesis
before implementation so later surfaces inherit one identity.

## Subject, audience, and job

The subject is a local instrument for directing capable CLI agents and
reviewing the files they change. It is used for hours at a time by one person
and a few technically fluent teammates.

The window has one job: make concurrent machine work legible without competing
with the document under review.

The visual posture is neither chat application nor operations dashboard. It is
a precise desktop instrument: dense, quiet, tactile, and slightly idiosyncratic.

## Design plan

### Palette

Parchment is the reference theme. Every other theme preserves the same spatial
relationships through existing tokens.

| Role | Name | Reference |
|---|---|---|
| Outer frame | Paper grey | `#ebe9e3` |
| Instrument chrome | Porcelain | `#f9f8f5` |
| Work surface | White | `#ffffff` |
| Primary ink | Carbon | `#1a1a18` |
| Signal | Terracotta | `#c05d3c` |
| Structure | Hairline grey | `#d8d7d2` |

Color communicates structure and state, never category. Agent, app, routine,
and terminal kinds do not receive competing brand colors. The single accent
marks selection, activity, attention, and the current writing locus.

### Type

- **IBM Plex Sans** carries UI language, controls, and human-readable status.
- **IBM Plex Mono** carries paths, terminal text, timestamps, flags, compact
  metadata, and dynamic-activity monograms.
- **IBM Plex Serif** remains available for authored prose and rich document
  presentation, not shell chrome.

The shell uses a tight hierarchy rather than oversized headings. Titles are
readable words; status and metadata are compact instruments. Uppercase is
reserved for short section markers, never paragraphs or primary actions.

### Layout

```
-------------+------------------------------+-------------------------+
| Sidebar    | Activity header              | Editor header           |
| workspace  +------------------------------+-------------------------+
| launchers  |                              | tabs                    |
| apps       | terminal / agent / files /   | inline AI / diff        |
|            | app / routine                | CodeMirror              |
| activities |                              | comments                |
| settings   |                              |                         |
+-------------+------------------------------+-------------------------+
```

The three panes run edge to edge. Chrome becomes lighter toward authored
content. One-pixel rules provide structure; there is no canvas moat, pane card,
or shadow.

Expanded widths begin at Sidebar 240px, flexible Activity, and Editor 520px.
Sidebar collapses to 52px. Activity and Editor collapse to 44px. The precise
invariants live in [synthesis.md](synthesis.md).

### Signature

The permanent rail system is the signature.

When collapsed, the Sidebar becomes a live index of the workspace rather than
an anonymous strip:

- fixed launchers retain their icons;
- dynamic Activities retain order and become one- or two-character monograms;
- a small overlaid signal shows working, waiting, done, or error;
- row geometry remains identical to the expanded tray;
- the rail and first expanded header form one continuous L of chrome.

This is memorable because it makes concurrent agents glanceable at 52px without
turning the window into a dashboard.

### Motion

Motion is concentrated in two moments:

1. Pane expansion and collapse preserve spatial continuity while content stays
   mounted.
2. A restrained working glyph/status signal shows that an Activity is alive.

Hover feedback is instant. Status does not pulse continuously. Reduced-motion
mode removes nonessential interpolation while preserving state changes.

### Copy

Controls use direct verbs: Open folder, New terminal, Stop, Resume, Clear,
Reveal, Run now. Status uses short factual words: Working, Input, Done, Stopped,
Error.

Empty states name the next useful action. Failures identify the failed object
and provide recovery; they do not apologize or use generic encouragement.

## Self-critique

The initial direction risked reading as a generic Linear-style three-column
desktop shell: neutral chrome, hairline dividers, and compact rows are common.
The design therefore spends its one deliberate risk on the rail grammar rather
than adding decoration.

The revised direction makes the collapsed shell an information-dense mode in
its own right. Dynamic monograms, precise row preservation, state overlays, and
the continuous L-shaped chrome bridge come directly from this product's need to
watch multiple agents while reviewing a document. They would not make equal
sense in a generic project manager.

The rest stays disciplined so that signature remains legible:

- no category color rainbow;
- no floating pane cards;
- no large dashboard metrics;
- no conversational mascots;
- no ornamental gradients;
- no animation scattered across controls.

## Implementation rules

- Use Tailwind utilities backed by existing tokens in Vue templates.
- Use component CSS only for layout mechanics, vendor-prefixed native chrome,
  CodeMirror/xterm deep styling, or animation keyframes.
- Every control has an immediate hover background appropriate to its surface.
- Controls keep the native arrow cursor; hyperlinks alone use pointer.
- Focus treatment uses `:focus-visible`.
- Railed panes stay mounted or preserve equivalent host state.
- Test every theme at expanded, collapsed, and narrow-window layouts.
- New app UI may be bespoke, but the host chrome follows this document.
