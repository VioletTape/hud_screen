# ADR 0001: Content-sized HUD cards

- Status: Accepted
- Date: 2026-10-06

## Context

The HUD used equal grid tracks, so short widgets such as Slack occupied as much
space as widgets with more content. GitLab and Meetings also spent space on
headers that add no useful information to those cards.

## Requirements

- A widget's height encloses its content and compact padding; it must not stretch
  to fill unused vertical space.
- The HUD layout uses the full available display width: horizontal cards spread
  across the row while retaining content-sized borders, and vertical cards fill
  the available width.
- On the dedicated 480×1920 portrait screen, the card column spans the full
  viewport width. Cards follow one another with no gaps; unused height remains
  after the last card rather than being distributed between cards.
- Empty space in a widget must not be reserved for content that is not present.
- GitLab and Meetings have no header. Their status indicators remain visible as
  small dots positioned outside the content flow.
- Slack's sections size to their contents instead of expanding to fill the card.
- Horizontal HUD cards flow across the row and may wrap. Portrait cards stack
  full-width with their height determined by content.

## Decision

Use a full-width flex layout. Horizontal cards retain content-sized borders and
spread across the available row. In portrait view, stack full-width cards and
place them back-to-back from the top, keeping card height tied to content.
Remove stretching from the Slack feed, and render GitLab and Meetings without
headers, with status dots positioned independently of their content.

## Consequences

Horizontal cards use the full display width without widening their borders. On
the 480×1920 portrait display, full-width content-sized cards stack without
gaps, leaving any unused height after the last card.
