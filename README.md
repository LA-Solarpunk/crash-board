# CRASH Space Departure Board

real-time transit + calendar + status display for crash space. shows upcoming events, bus arrivals, space open/closed status, weather.

## what it does

- **events**: pulls from crash space public google calendar, shows next 5 as big cards, next 10 in condensed list
- **buses**: live LA Metro arrivals at venice & motor (stops 6939, 15292) via swiftly GTFS-RT feed
- **status**: scrapes crashspacela.com/sign to show if space is open/closed
- **weather**: current conditions (optional)

displays as fullscreen dashboard with orange/black/white aesthetic

## setup

### 1. install dependencies

```bash
cd crash-board
npm install
```

### 2. create .env file

copy `.env.example` to `.env` and fill in your keys:

```bash
cp .env.example .env
nano .env
```

required:
- `SWIFTLY_API_KEY` - get from api.goswift.ly (free tier: 1500 calls/month)
- `GOOGLE_CALENDAR_ID` - crashspacela@gmail.com (or your calendar)
- `GOOGLE_API_KEY` - from console.cloud.google.com (enable Calendar API)

optional:
- `WEATHER_API_KEY` - from openweathermap.org
- `LOCATION_LAT/LON` - defaults to crash space coords

### 3. run the server

```bash
node server.js
```

or with docker:

```bash
docker-compose up -d
```

server runs on port 3000 (configurable via PORT env var)

### 4. display it

point a browser at `http://localhost:3000` and fullscreen it (F11)

for kiosk mode on boot, see the systemd service setup in the deployment section below

## how it works

### data flow

server fetches data from various APIs and caches it:
- buses: every 30 seconds (well within quota)
- calendar: every 5 minutes
- weather: every 10 minutes  
- space status: every minute

frontend polls `/api/all` every 30 seconds to get fresh data

### bus tracking

uses LA Metro GTFS-RT feed via swiftly. parses the entire 4.7MB feed server-side (node has unlimited RAM vs the old ESP32 2KB limit), filters to just buses arriving at our stops.

currently showing route 33. to add more routes, edit `server.js` and remove or modify the route filtering logic.

stops near crash space:
- 6939: venice & motor eastbound (towards downtown)
- 15292: venice & motor westbound (towards santa monica)

add more stops by including their IDs in the `ourStops` array

### arrival states

- **BRD** (boarding): <1 minute away, pulses orange
- **ARR** (arriving): 1-2 minutes away, static orange  
- **X min**: >2 minutes away, white

### live events

events happening RIGHT NOW get inverted colors (orange bg, black text). detected by checking if current time is between start and end times.

### tags

parses event titles and descriptions for:
- [HYBRID] or (Members Only) in title → tags at bottom of card
- "open to the public" in description → PUBLIC tag

tags on live events invert too (black bg on orange card)

## deployment on crash space kiosk

### systemd service for node server

```bash
sudo nano /etc/systemd/system/crash-board.service
```

```ini
[Unit]
Description=CRASH Space Departure Board
After=network.target

[Service]
Type=simple
User=crash
WorkingDirectory=/opt/crash-board
ExecStart=/opt/node/bin/node server.js
Restart=always
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable crash-board
sudo systemctl start crash-board
```

### systemd service for firefox kiosk

```bash
mkdir -p ~/.config/systemd/user
nano ~/.config/systemd/user/crash-board-display.service
```

```ini
[Unit]
Description=CRASH Space Board Display
After=graphical.target

[Service]
Type=simple
Environment="DISPLAY=:1"
Environment="XAUTHORITY=/run/user/1000/xauth_xqzhrN"
ExecStart=/usr/bin/firefox --kiosk http://localhost:3000
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

adjust DISPLAY and XAUTHORITY to match your X session (check with `systemctl --user show-environment`)

```bash
systemctl --user daemon-reload
systemctl --user enable crash-board-display
systemctl --user start crash-board-display
```

### logs

```bash
# server logs
sudo journalctl -u crash-board -f

# firefox logs
journalctl --user -u crash-board-display -f
```

## customization

### adding more transit routes

edit `server.js`, find the bus parsing section. currently filters to route 33:

```javascript
// to show ALL routes at these stops, remove this filter:
if (!routeId.startsWith('33-')) continue;
```

or change to specific routes:

```javascript
const wantedRoutes = ['33', 'R3', '233']; // whatever routes you want
const route = routeId.split('-')[0];
if (!wantedRoutes.includes(route)) continue;
```

### adding more bus stops

add stop IDs to the `ourStops` array in `server.js`:

```javascript
const ourStops = ['6939', '15292', 'YOUR_STOP_ID_HERE'];
```

find stop IDs by checking LA Metro's GTFS data or by inspecting the feed

### changing refresh rates

edit `REFRESH_INTERVALS` in `server.js`:

```javascript
const REFRESH_INTERVALS = {
  buses: 30 * 1000,          // 30 seconds
  calendar: 5 * 60 * 1000,   // 5 minutes
  weather: 10 * 60 * 1000,   // 10 minutes
  spaceStatus: 1 * 60 * 1000 // 1 minute
};
```

bus quota: 180 requests per 15 min = 720/hour. at 30 sec refresh that's 120/hour - plenty of headroom

### styling

edit `public/style.css`. current theme:
- background: black (#000)
- primary: orange (#ff8800)  
- text: white (#fff)
- accents: greys

fonts:
- sixtyfour (7-segment style) for times/clock
- helvetica neue for everything else

## troubleshooting

### buses not showing up

check server logs for "fetched X bus departures from swiftly"

if X is 0:
- verify SWIFTLY_API_KEY is correct
- check stops are right (6939, 15292)
- route 33 might not have buses running right now

test the api directly:
```bash
curl -H "Authorization: YOUR_KEY" "https://api.goswift.ly/real-time/lametro/gtfs-rt-trip-updates?format=json" | jq '.entity | length'
```

### calendar events not showing

- make sure calendar is public
- verify GOOGLE_API_KEY has Calendar API enabled
- check GOOGLE_CALENDAR_ID is correct

### space status stuck

the sign scraper looks for specific HTML patterns. if crashspacela.com/sign changes format, the parser might break. check server logs for errors.

## api quotas

- swiftly: 1500 calls/month = 50/day. at 30sec refresh during 16 active hours = ~2000 calls/day. might need to back off to 1-2 min refresh or upgrade plan
- google calendar: 1M requests/day (lol we'll never hit this)
- openweathermap: 1000 calls/day free tier

## file structure

```
crash-board/
├── server.js           # main server, api fetching/caching
├── public/
│   ├── index.html      # frontend, creates the UI
│   └── style.css       # orange/black theme
├── package.json        # dependencies
├── .env.example        # config template
├── .env               # your actual config (gitignored)
├── Dockerfile         # if you wanna containerize it
├── docker-compose.yml # docker setup
└── README.md          # this file
```

## future ideas

- add culver city bus routes (have the GTFS data)
- add UCLA routes
- weather forecast instead of just current
- show recent slack messages?
- member check-ins/outs
- equipment status (is the laser cutter working?)

## credits

built during a very long ssh session trying to get transit APIs to work

swiftly GTFS-RT feed is 4.7MB of JSON. we parse it all server-side because node doesn't give a fuck. the ESP32 cried.
