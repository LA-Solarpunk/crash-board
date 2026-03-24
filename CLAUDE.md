# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Real-time transit + calendar + status display for CRASH Space. A fullscreen departure board showing upcoming events, bus arrivals, space open/closed status, and weather in an orange/black/white aesthetic.

## Running the Project

### Development
```bash
npm install
node server.js
```

Server runs on port 3000 by default (configurable via `PORT` env var).
Access at `http://localhost:3000`

### Docker
```bash
docker-compose up -d
```

## Environment Configuration

Copy `.env.example` to `.env` and configure:

**Required:**
- `SWIFTLY_API_KEY` - LA Metro GTFS-RT feed access (api.goswift.ly)
- `GOOGLE_CALENDAR_ID` - Calendar to pull events from
- `GOOGLE_API_KEY` - Google Calendar API access

**Optional:**
- `WEATHER_API_KEY` - OpenWeatherMap API key
- `LOCATION_LAT/LON` - Location coordinates (defaults to CRASH Space)
- `SPACE_STATUS_URL` - Space status endpoint
- `PORT` - Server port (default: 3000)

## Architecture

### Server-Side (server.js)

**Data Fetching Pattern:**
- All external APIs are called server-side with caching
- Cache refresh intervals prevent quota exhaustion:
  - Buses: 30 seconds (GTFS-RT feed)
  - Calendar: 5 minutes (Google Calendar API)
  - Weather: 10 minutes (OpenWeatherMap)
  - Space Status: 1 minute (web scraping)
- Background refresh runs every minute, respects individual cache TTLs
- Returns stale data on API errors to maintain display uptime

**Bus Data Flow:**
- Fetches entire 4.7MB LA Metro GTFS-RT feed from Swiftly
- Server-side parsing filters to specific stops (`ourStops` array in server.js:73)
- Currently configured for Venice & Motor stops: 6939 (eastbound), 15292 (westbound)
- Route filtering logic at server.js:86 (currently all routes shown)
- Calculates arrival states: BRD (<1 min), ARR (1-2 min), or minutes remaining
- Sorts by arrival time, returns top 20 departures

**API Endpoints:**
- `/api/buses` - Bus departures only (for ESP32 VFD compatibility)
- `/api/all` - Combined data payload for web dashboard

**Space Status Parsing:**
- Scrapes crashspacela.com/sign HTML
- Looks for specific bgcolor patterns to determine open/closed state
- Extracts message and last update timestamp via regex

### Frontend (public/)

**Single-Page Architecture:**
- Pure JavaScript (no frameworks)
- Polls `/api/all` every 30 seconds
- Clock updates every second locally
- Grid-based layout using CSS Grid

**Display Layout:**
- **Top Row**: 6-column grid
  - First 5 event cards (expandable grid items)
  - 1 buses card (fixed width)
- **Bottom Row**: 2-column grid
  - Future events list (condensed, next 10 events after the first 5)
  - Space status card
- **Info Bar**: Fixed bottom bar with date and clock

**Event Card States:**
- **Live Events**: Orange background when current time between start/end
- **Next Event**: First upcoming event gets "Next" tag
- **Cancelled**: Greyed out with CANCELLED badge
- Tags parsed from title brackets/parens: [HYBRID], (Members Only), "open to the public" in description

**Visual Styling:**
- Primary: Orange (#ff8800)
- Background: Black (#000)
- Text: White (#fff)
- Fonts:
  - 'Sixtyfour' for times/clock (7-segment style)
  - 'Helvetica Neue' for body text
- Boarding buses pulse orange animation

## Customization Points

### Adding Transit Routes
Edit `server.js` around line 86 to modify route filtering:
```javascript
// Show specific routes only
const wantedRoutes = ['33', 'R3', '233'];
const route = routeId.split('-')[0];
if (!wantedRoutes.includes(route)) continue;
```

### Adding Bus Stops
Modify `ourStops` array in `server.js:73`:
```javascript
const ourStops = ['6939', '15292', 'YOUR_STOP_ID'];
```

### Adjusting Refresh Rates
Edit `REFRESH_INTERVALS` object in `server.js:31-36`

Note: Swiftly free tier = 1500 calls/month. At 30-second refresh during 16-hour operation = ~1920 calls/day. Monitor usage or adjust interval.

## API Quota Considerations

- Swiftly: 1500 calls/month free tier (may need to throttle refresh rate)
- Google Calendar: 1M requests/day
- OpenWeatherMap: 1000 calls/day free tier

Server-side caching is critical to staying within quotas.

## Deployment Notes

Production deployment typically uses systemd services:
- One service for the Node.js server
- One user service for Firefox kiosk mode
- See README.md lines 103-174 for full systemd setup
- Logs viewable via `journalctl -u crash-board -f`

## Key Implementation Details

**HTML Sanitization:**
- Event descriptions may contain HTML from Google Calendar
- `stripHtml()` function converts `<br>` to newlines, strips other tags
- Applied to both title and description fields

**Tag Parsing Logic:**
- Regex extracts content from brackets `[]` and parentheses `()` in event titles
- Case-insensitive keyword matching for tag types
- Tags extend outside card borders using negative margins for visual effect
- Tags invert colors when event is live (black on orange vs orange on black)

**Time Display:**
- All times displayed in 24-hour format (en-GB locale)
- Bus times use Sixtyfour font (7-segment style)
- Event cards show full date + time range if end time exists
