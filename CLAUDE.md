# CLAUDE.md

Guidance for Claude Code when working in this repo. README.md is the human-written
overview; keep that voice when touching docs. This file is the operational detail.

## What this is

Fullscreen kiosk board for CRASH Space: next events, LA Metro / Big Blue Bus
arrivals, 3D printer status, weather, and space open/closed. Orange-on-black,
no user interaction, small screen viewed from across a room.

## Running it

```bash
npm install
cp .env.example .env   # fill in keys
node server.js         # http://localhost:3000
```

No build step. Env vars the code reads (everything except the first three has a default):

- `SWIFTLY_API_KEY` - live LA Metro data. Blank = timetable-only mode, fine for dev.
- `GOOGLE_CALENDAR_ID`, `GOOGLE_API_KEY` - public calendar + key with Calendar API enabled.
- `LOCATION_LAT`, `LOCATION_LON` - for NWS weather. Default is CRASH Space (Venice & Motor).
- `SPACE_STATUS_URL` - sign page to scrape. Default crashspacela.com/sign.
- `PRINTER_API_URL` - printer status service. Default `http://archlinux:3001/`, which only
  resolves on the production box. Set it to the LAN address when testing from a laptop
  instead of editing server.js.
- `PORT` - default 3000.

## Layout

- `server.js` - the whole backend. Express, serves `public/`, two JSON endpoints.
- `public/index.html`, `public/script.js`, `public/style.css` - the whole frontend. Vanilla JS.
- `schedules/*.json` - static timetables (Metro 33, BBB Rapid 12, Culver City 1 & 3) split by
  weekday/saturday/sunday. Only 33 and R12 are loaded. Metro revises schedules a couple
  of times a year; these go stale.
- `schedules/bus_tracker_v3.ino`, `schedules.h` - the older ESP32 VFD tracker. `/api/buses`
  exists for it.

## How the backend behaves

- Every source is fetched server-side and cached in memory with its own TTL: buses and
  printers 30 s, space status 1 min, calendar 5 min, weather 10 min. A timer runs every
  minute and each fetcher decides whether it is stale. Requests also check on demand.
- On any fetch error a source returns its last good data, so the board goes stale rather
  than blank. Exception: buses fall back to the timetable when Swiftly is unavailable
  (`useScheduleFallback`), because frozen live minutes are worse than a schedule.
- Buses: the full Swiftly GTFS-RT trip-updates feed (~4.7 MB) is scanned for stop IDs
  6939 and 15292 (Venice & Motor). All routes at those stops are kept. Live departures are
  merged with the timetable; a scheduled entry is dropped when a live one matches on route,
  destination, and time within 5 minutes. Each departure carries `isLive`.
- Weather: NWS, no key. Gridpoint resolved once per process, then hourly + daily forecast.
- Space status: HTML scrape of the sign page keyed on table bgcolor. Fragile. The sign has
  been stale since mid-2026, so the board shows closed.
- Printers: passthrough of an external service's JSON, keyed by printer name with
  `status`, `time_remaining` (seconds), and `prusa`/`bambu` flags.
- Endpoints: `/api/all` (everything + unix timestamp, polled by the page every 30 s) and
  `/api/buses` (departures only).

## Frontend notes

- Polls `/api/all` every 30 s. Clock ticks locally. Future-events list scrolls every 5 s.
  Active printer cards alternate ETA / time-left every 5 s. Cursor hides after 3 s idle.
- Bus card is three fixed slots: 33 Downtown, 33 Santa Monica, Rapid 12 UCLA.
- Event tags come from `[brackets]` / `(parens)` in the title and "open to the public" in
  the description. Live events invert to orange. Cancelled events grey out.
- Printer model names are hardcoded in `script.js` (`PRINTER_MODELS`).
- Fonts: Sixtyfour for clocks/ETAs, Helvetica Neue for body. Primary color `#ff8800`.

## Conventions

- Match the file's existing style: 2-space indent in `server.js`, 4-space in `script.js`,
  double quotes, trailing commas. No framework, no bundler, no TypeScript.
- Times are 24-hour everywhere.
- Never commit `.env`. Never hardcode a LAN IP; add an env var with a sane default instead.
- Frontend changes need the kiosk page reloaded (F5 on the box). Backend changes need a
  service restart. Nothing needs a build.

## Deploy

- Production: systemd `crash-board.service` runs `node server.js` from `/opt/crash-board`
  as user `crash`, with Firefox in kiosk mode on the same machine.
- Git remotes on the maintainer laptop: `origin` is a bare repo on the production box
  (deploy target), `github` is the public repo `LA-Solarpunk/crash-board`. Branch is `main`.
- Deploy a change: push `main` to both remotes, `git pull` in `/opt/crash-board`, then
  restart the service. Logs: `journalctl -u crash-board -f`.

## Quotas

Swiftly free tier is the only one that matters. Google Calendar and NWS are effectively
unlimited at this polling rate.
