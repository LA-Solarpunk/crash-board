# CRASH Calendar Board
*by Lavie Ohana / @lv154 + contributions from Serguey, Nathan, Gaia, and other Crashers!*

This is the repo for the Calendar at CRASH Space, which sits atop the space on the Solarpunk group's server. The calendar is responsible for a couple core functions:
- Display the immediate next few events at CRASH prominently, as well as a list into the future
- Display the status of certain tools at CRASH, including the 3D Printers
- Show transit timing for CRASH's local bus lines (Metro 33, Rapid 12, etc)
- Provide local weather, date, and time
- Show whether the space is open or closed, and for how long *(NOTE: Currently inoperable since the space no longer has an open status source)*

The calendar itself is relatively simple and just a webpage that is displayed full-screen on the server (an all-in-one PC with a 16:9, 20-something inch monitor). The board requires no user interaction. 

Information is displayed as a series of rotating and static cards, with an overall white and amber-on-black theme loosely inspired by British railway departure boards. Beyond amber, other colors are used extremely sparingly throughout the board. Since the screen is pretty small, a current primary challenge is displaying information at a large enough scale to be visible across the room. 


## Backend

The backend is pretty simple (and relatively claude-slopped, my apologies, I'm not a programmer.) `server.js` handles basically everything, it's a single Node process that serves the frontend and two JSON endpoints. All processing is done server-side, largely consisting of pulling the few data sources (buses, printers, space status, calendar, and weather) the board uses.

**Endpoints:**
- `/api/all` - returns buses, calendar, weather, space status, printers, and a unix timestamp. This is polled by the frontend every 30 seconds.
- `/api/buses` - returns bus departures only. This endpoint was exposed for the previous version of the CRASH bus tracker (which still lives under /schedules/ as an ESP32 project). 

### Data sources:
**Calendar:** Google Calendar v3, plain API key. Polled every 5 minutes from the public CRASH calendar. 
Some regex processing is done on titles and descriptions to extract certain keyword tags, such as "members only," or "online/hybrid," which are stripped and shown as tags on events instead. 

**Transit tracking:**
Live data comes from Metro Los Angeles' GTFS-RT trip-updates feed via Swiftly. This is about 4.7MB of JSON per request (for some reason, the real-time API gives you *every bus in Los Angeles,* no matter what) which the backend filters for only one pair of stops: Line 33's stops at Venice and Motor.

At the moment, the Big Blue Bus Rapid 12's tracking isn't real-time, and the board just displays a fixed schedule. Fixing this isn't an urgent priority, as CRASH is at the start of the line for the Rapid 12, so on-time performance is near-perfect.

The board also doesn't currently show the Culver City 1 and 3, due to screen space constraints and a lack of real time data and convoluted fixed schedules. Fixing this is a decent priority.
- Another possible feature: showing connection times to the Expo line for the 33 and 12. Metro exposes a free web-socket realtime feed for both rail and bus timings which could be used here. We don't use it for buses, because the bus real-time feed is ~760 kb/s!

Other notes:
- Static timetables are in `schedules/` as JSON. Metro updates schedules every half-a-year, so these should be updated periodically.
- The backend automatically compares live and scheduled departures against each other, and will always solely show the live departure if it has the same route, destination, and is within 5 minutes. Otherwise, both are shown. Live departures carry an `isLive` tag for the frontend.
- If no API key is set/some other outage occurs, the board will fall back to the hard-coded scheduled timetable.
- Status codes: Boarding (BRD) at <1 minute to arrival, Arriving (ARR) at 1-2 minutes, otherwise ETAs are returned in minutes-to-go.
 
**Weather:**
- National Weather Service API, free, no key. Two steps: resolve lat/lon to a gridpoint once per process lifetime, then hit the hourly forecast for current temp, conditions, humidity, and wind, and the daily forecast for today's high and low plus the next six periods.
- Coordinates are currently hardcoded in server.js. There are location env vars, but these are currently ignored. 

**Space status:** 
For this, the board scrapes the HTML of crashspacela.com/sign to pull the background color, which is red for closed and green for open. as well as the other text on the page to extract timing and other details. Since this page has been stale since ~July 2026, the board will effectively always show "Closed, last open July" until the status source is fixed.

**Printers:** This fetches JSON from a separate printer-status service on port 3001 of the server's host.
- Expected shape is an object keyed by printer name, each with a status string, a time_remaining in seconds, and prusa or bambu flags. Status values seen: Printing, Attention, Idle, Finished, Error.

## Frontend
The frontend is pretty simple:
- Vanilla JS, one HTML file and one CSS file. 
- Polls every 30 seconds. The clock ticks locally every second. The future-events list auto-scrolls every 5 seconds. Active printer cards alternate between ETA and time-left every 5 seconds.
- The bus card has three fixed slots: 33 toward Downtown, 33 toward Santa Monica, and Rapid 12 toward UCLA from Venice & Overland. Each shows the next bus plus two following. Anything over an hour out renders as a clock time instead of minutes.
- Event cards: live events invert to orange, the first upcoming one gets a "Next" tag, cancelled ones are greyed. Tags come from square brackets or parens in the title, plus "open to the public" in the description.

## How to actually run it
You'll need Node (18 or newer, that's what the server runs) and a copy of this repo.

```bash
npm install
node server.js
```

Then point a browser at http://localhost:3000 and hit F11. That's pretty much it, not much to it.

**Keys:** the board reads a `.env` file in the repo root. You really only need three values for it to do anything useful:

```
SWIFTLY_API_KEY=...
GOOGLE_CALENDAR_ID=...
GOOGLE_API_KEY=...
PORT=3000
```

- `SWIFTLY_API_KEY` is for live Metro data, free tier from api.goswift.ly. If you leave it out, the board just runs on the fixed timetables in `schedules/`, which is honestly a nice way to poke at it without burning API calls.
- `GOOGLE_CALENDAR_ID` and `GOOGLE_API_KEY` need the calendar to be public and the key to have the Calendar API turned on in the Google Cloud console. Without these the events section is just empty.
- `PORT` is optional and defaults to 3000.

Weather and printers don't need keys. Weather goes straight to the NWS, and printers expect the printer status service to be answering at `http://archlinux:3001` (at the moment hardcoded in `server.js`, sorry). On any other machine that card just says "no printers" and everything else works fine.

There's a Dockerfile and a docker-compose in here too. They work, but the real board doesn't use them.

**On the actual server:** the board runs as a systemd service (`crash-board.service`) out of `/opt/crash-board`, and Firefox runs in kiosk mode as a user service pointed at localhost:3000. Deploying a change is: push `main` to the bare repo on the server, ssh in, `git pull` in `/opt/crash-board`, then `systemctl restart crash-board`. 

--- 

*Last updated September 4, 2026 by Lavie O.*
