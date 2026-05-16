require("dotenv").config();
const express = require("express");
const fetch = require("node-fetch");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;

// serve static files
app.use(express.static("public"));

// cached data - refresh intervals
let cachedData = {
  buses: { data: [], lastFetch: 0 },
  calendar: { data: [], lastFetch: 0 },
  weather: { data: {}, lastFetch: 0 },
  spaceStatus: { data: {}, lastFetch: 0 },
  printers: { data: {}, lastFetch: 0 },
};

// config from env
const SWIFTLY_API_KEY = process.env.SWIFTLY_API_KEY;
const LOCATION_LAT = parseFloat(process.env.LOCATION_LAT);
const LOCATION_LON = parseFloat(process.env.LOCATION_LON);
const GOOGLE_CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const SPACE_STATUS_URL = process.env.SPACE_STATUS_URL;

// refresh intervals (milliseconds)
const REFRESH_INTERVALS = {
  buses: 30 * 1000, // 30 sec - realtime baby
  calendar: 5 * 60 * 1000, // 5 min
  weather: 10 * 60 * 1000, // 10 min
  spaceStatus: 1 * 60 * 1000, // 1 min
  printers: 30 * 1000, // 30 sec
};

// ===== SCHEDULE LOADING (BBB R12 + Culver City 1 & 3) =====
// loads static schedules and calculates upcoming departures
// these routes will eventually use Transit API for real-time data

function getDayType() {
  const now = new Date();
  const day = now.getDay(); // 0 = Sunday, 6 = Saturday
  if (day === 0) return "sunday";
  if (day === 6) return "saturday";
  return "weekday";
}

function loadSchedules() {
  const dayType = getDayType();
  const schedules = {};

  try {
    // BBB R12 (Big Blue Bus Rapid)
    const r12Path = path.join(__dirname, "schedules", `r12_${dayType}.json`);
    if (fs.existsSync(r12Path)) {
      schedules.r12 = JSON.parse(fs.readFileSync(r12Path, "utf8"));
    }

    // Metro 33
    const m33Path = path.join(__dirname, "schedules", `m33_${dayType}.json`);
    if (fs.existsSync(m33Path)) {
      schedules.m33 = JSON.parse(fs.readFileSync(m33Path, "utf8"));
    }

    console.log(
      `loaded schedules for ${dayType}: R12=${(schedules.r12 && schedules.r12.length) || 0}, 33=${(schedules.m33 && schedules.m33.length) || 0}`,
    );
  } catch (err) {
    console.error("error loading schedules:", err.message);
  }

  return schedules;
}

function getScheduledDepartures() {
  const schedules = loadSchedules();
  const now = new Date();
  const nowSeconds =
    now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();

  const departures = [];

  // process all loaded schedules
  for (const [key, schedule] of Object.entries(schedules)) {
    if (!schedule) continue;

    for (const entry of schedule) {
      let busSeconds = entry.seconds;

      // Handle late-night times (e.g., 29:00:00 = 5am next day)
      // Normalize times > 86400 seconds
      const daySeconds = 86400;
      if (busSeconds >= daySeconds) {
        busSeconds = busSeconds % daySeconds;
      }

      let secondsUntil = busSeconds - nowSeconds;

      // Handle midnight wraparound
      if (secondsUntil < 0) {
        // Check if it's tomorrow (within next 24 hours)
        secondsUntil += daySeconds;
      }

      // Skip if already departed or too far in future (> 2 hours)
      if (secondsUntil < 0 || secondsUntil > 7200) continue;

      const minutes = Math.floor(secondsUntil / 60);

      // BRD = boarding (<1 min), ARR = arriving (1-2 min)
      let status = null;
      if (minutes < 1) status = "BRD";
      else if (minutes <= 2) status = "ARR";

      departures.push({
        route: entry.route,
        destination: entry.dest,
        minutes: minutes,
        status: status,
        isLive: false, // scheduled, not real-time
      });
    }
  }

  return departures;
}

// ===== TRANSIT API (BBB + Culver City real-time) =====
// placeholder for future Transit API integration
// will provide real-time data for R12, CC1, CC3
// currently using static schedules as fallback

async function fetchTransitAPIData() {
  // TODO: implement Transit API calls
  // API allows one request every 30 minutes
  // When implemented, this will return real-time departure predictions
  // for BBB R12 and Culver City routes 1 & 3

  // For now, return empty - we use schedules instead
  return [];
}

// ===== BUS DATA (LA METRO GTFS-RT via Swiftly) =====
// parses the full 4.7MB metro feed server-side, filters to stops near crash space
// stops: 6939 (eastbound), 15292 (westbound) at venice & motor
// to add more routes: remove or modify the route filtering below
// to add more stops: add stop IDs to the ourStops array

async function fetchBusData() {
  const now = Date.now();
  if (now - cachedData.buses.lastFetch < REFRESH_INTERVALS.buses) {
    return cachedData.buses.data;
  }

  if (!SWIFTLY_API_KEY) {
    console.log("no swiftly api key - using scheduled departures only");
    const scheduledDepartures = getScheduledDepartures();
    cachedData.buses.data = scheduledDepartures.slice(0, 20);
    cachedData.buses.lastFetch = now;
    return cachedData.buses.data;
  }

  try {
    const url =
      "https://api.goswift.ly/real-time/lametro/gtfs-rt-trip-updates?format=json";
    const resp = await fetch(url, {
      headers: { Authorization: SWIFTLY_API_KEY },
    });

    if (!resp.ok) {
      console.error("swiftly api error:", resp.status);
      return cachedData.buses.data;
    }

    const data = await resp.json();
    console.log(
      `feed has ${(data.entity && data.entity.length) || 0} total entities`,
    );

    const departures = [];
    const nowUnix = Math.floor(Date.now() / 1000);

    // our stops near crash space (venice & motor)
    const ourStops = ["6939", "15292"]; // eastbound and westbound

    let route33count = 0;
    let matchedStops = 0;

    // find ALL buses at our stops (not just route 33)
    for (const entity of data.entity || []) {
      const tripUpdate = entity.tripUpdate;
      if (!tripUpdate || !tripUpdate.trip) continue;

      const trip = tripUpdate.trip;
      const routeId = trip.routeId || "";

      // track route 33 for logging
      if (routeId.startsWith("33-")) route33count++;

      const headsign = trip.tripHeadsign || "";

      // check stop time updates for our stops
      const stopTimeUpdate = tripUpdate.stopTimeUpdate || [];
      for (const stu of stopTimeUpdate) {
        if (!ourStops.includes(stu.stopId)) continue;

        matchedStops++;

        if (!stu.arrival || !stu.arrival.time) continue;

        const arrivalTime = stu.arrival.time;
        const secondsUntil = arrivalTime - nowUnix;

        if (secondsUntil < 0 || secondsUntil > 3600) continue;

        const minutes = Math.floor(secondsUntil / 60);

        // BRD = boarding (<1 min), ARR = arriving (1-2 min)
        let status = null;
        if (minutes < 1) status = "BRD";
        else if (minutes <= 2) status = "ARR";

        let destination = headsign;
        if (!destination) {
          destination = stu.stopId === "6939" ? "Downtown LA" : "Santa Monica";
        }

        departures.push({
          route: routeId.split("-")[0], // "33-13196" -> "33"
          destination: destination,
          minutes: minutes,
          status: status,
          isLive: stu.arrival.realtime || false,
        });
      }
    }

    // merge with scheduled departures and deduplicate
    const scheduledDepartures = getScheduledDepartures();

    // Match live buses to scheduled ones to avoid duplicates
    // A live bus matches a scheduled one if:
    // - Same route
    // - Same destination (close enough)
    // - Within 5 minutes of scheduled time
    const dedupedScheduled = scheduledDepartures.filter((scheduled) => {
      const matchingLive = departures.find((live) => {
        if (live.route !== scheduled.route) return false;

        // Check if destinations match (compare key words)
        const liveDestLower = live.destination.toLowerCase();
        const schedDestLower = scheduled.destination.toLowerCase();

        // Check for key destination matches
        const destMatch =
          (liveDestLower.includes("downtown") &&
            schedDestLower.includes("downtown")) ||
          (liveDestLower.includes("santa monica") &&
            schedDestLower.includes("santa monica")) ||
          liveDestLower.includes(schedDestLower.substring(0, 8)) ||
          schedDestLower.includes(liveDestLower.substring(0, 8));

        if (!destMatch) return false;

        // Check if times are within 5 minutes
        const timeDiff = Math.abs(live.minutes - scheduled.minutes);
        return timeDiff <= 5;
      });

      if (matchingLive) {
        console.log(
          `Dedup: Scheduled ${scheduled.route} to ${scheduled.destination} at ${scheduled.minutes}min matches live at ${matchingLive.minutes}min`,
        );
      }

      return !matchingLive;
    });

    // Put live buses first, then scheduled, so live buses are preferred in deduplication
    const allDepartures = [...departures, ...dedupedScheduled];

    // Remove duplicates within the combined list (even among scheduled buses)
    // Keep only unique route+destination+time combinations, preferring live buses
    const uniqueDepartures = [];
    const seen = new Set();

    // Process live buses first
    allDepartures
      .filter((d) => d.isLive)
      .forEach((dep) => {
        const key = `${dep.route}-${dep.destination}-${dep.minutes}`;
        if (!seen.has(key)) {
          seen.add(key);
          uniqueDepartures.push(dep);
        }
      });

    // Then process scheduled buses
    allDepartures
      .filter((d) => !d.isLive)
      .forEach((dep) => {
        const key = `${dep.route}-${dep.destination}-${dep.minutes}`;
        if (!seen.has(key)) {
          seen.add(key);
          uniqueDepartures.push(dep);
        }
      });

    // sort by time
    uniqueDepartures.sort((a, b) => a.minutes - b.minutes);

    console.log(
      `metro trips: ${departures.length}, scheduled trips: ${dedupedScheduled.length} (${scheduledDepartures.length} before dedup), unique: ${uniqueDepartures.length}`,
    );

    cachedData.buses.data = uniqueDepartures.slice(0, 20);
    cachedData.buses.lastFetch = now;

    console.log(
      `fetched ${allDepartures.length} bus departures (${departures.length} metro + ${scheduledDepartures.length} scheduled)`,
    );
    return cachedData.buses.data;
  } catch (err) {
    console.error("bus fetch error:", err.message);
    return cachedData.buses.data; // return stale on error
  }
}

// ===== CALENDAR DATA =====
async function fetchCalendarData() {
  const now = Date.now();
  if (now - cachedData.calendar.lastFetch < REFRESH_INTERVALS.calendar) {
    return cachedData.calendar.data;
  }

  if (!GOOGLE_API_KEY || !GOOGLE_CALENDAR_ID) {
    return [];
  }

  try {
    const timeMin = new Date().toISOString();
    const timeMax = new Date(
      Date.now() + 14 * 24 * 60 * 60 * 1000,
    ).toISOString(); // 2 weeks

    // explicitly request all fields including description
    const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(GOOGLE_CALENDAR_ID)}/events?key=${GOOGLE_API_KEY}&timeMin=${timeMin}&timeMax=${timeMax}&singleEvents=true&orderBy=startTime&maxResults=50`;

    const resp = await fetch(url);

    if (resp.ok) {
      const data = await resp.json();

      const events = (data.items || []).map((event) => ({
        title: event.summary || "Untitled Event",
        location: event.location || "",
        start: event.start.dateTime || event.start.date,
        end: event.end ? event.end.dateTime || event.end.date : null,
        description: event.description || "",
        status: event.status,
      }));

      cachedData.calendar.data = events;
      cachedData.calendar.lastFetch = now;

      console.log(`fetched ${events.length} calendar events`);
      return events;
    }

    return cachedData.calendar.data;
  } catch (err) {
    console.error("calendar fetch error:", err.message);
    return cachedData.calendar.data;
  }
}

// ===== WEATHER DATA (National Weather Service API - free, no key needed) =====

var nwsCache = {
  forecastUrl: null,
  forecastHourlyUrl: null,
  gridpointResolved: false,
};

var NWS_HEADERS = {
  "User-Agent": "(crash-space-board, github.com/lavie/crash-space-board)",
  Accept: "application/geo+json",
};

// CRASH Space coordinates
var NWS_LAT = 34.091254;
var NWS_LON = -118.405231;

async function resolveNWSGridpoint() {
  if (nwsCache.gridpointResolved) return;

  try {
    var pointsUrl = "https://api.weather.gov/points/" + NWS_LAT + "," + NWS_LON;
    var resp = await fetch(pointsUrl, { headers: NWS_HEADERS });
    if (!resp.ok) {
      console.error("NWS points error:", resp.status);
      return;
    }

    var data = await resp.json();
    nwsCache.forecastUrl = data.properties.forecast;
    nwsCache.forecastHourlyUrl = data.properties.forecastHourly;
    nwsCache.gridpointResolved = true;
    console.log(
      "NWS resolved: gridpoint " +
        data.properties.gridId +
        "/" +
        data.properties.gridX +
        "," +
        data.properties.gridY,
    );
  } catch (err) {
    console.error("NWS gridpoint resolve error:", err.message);
  }
}

async function fetchWeatherData() {
  var now = Date.now();
  if (now - cachedData.weather.lastFetch < REFRESH_INTERVALS.weather) {
    return cachedData.weather.data;
  }

  try {
    await resolveNWSGridpoint();
    if (!nwsCache.forecastHourlyUrl) return cachedData.weather.data || {};

    var hourlyResp = await fetch(nwsCache.forecastHourlyUrl, {
      headers: NWS_HEADERS,
    });
    if (!hourlyResp.ok) {
      console.error("NWS hourly forecast error:", hourlyResp.status);
      return cachedData.weather.data || {};
    }

    var hourlyData = await hourlyResp.json();
    var hourlyPeriods =
      (hourlyData.properties && hourlyData.properties.periods) || [];

    var current = hourlyPeriods[0];
    if (!current) return cachedData.weather.data || {};

    cachedData.weather.data = {
      temp: current.temperature,
      condition: current.shortForecast || "",
      description: current.shortForecast || "",
      humidity: current.relativeHumidity
        ? current.relativeHumidity.value
        : null,
      windSpeed: current.windSpeed || null,
      windDirection: current.windDirection || null,
    };

    // Get daily forecast for hi/lo + upcoming periods
    if (nwsCache.forecastUrl) {
      var fcResp = await fetch(nwsCache.forecastUrl, { headers: NWS_HEADERS });
      if (fcResp.ok) {
        var fcData = await fcResp.json();
        var periods = (fcData.properties && fcData.properties.periods) || [];
        var todayHi = null,
          todayLo = null;
        var forecast = [];
        for (var p = 0; p < Math.min(periods.length, 7); p++) {
          if (periods[p].isDaytime && todayHi === null)
            todayHi = periods[p].temperature;
          if (!periods[p].isDaytime && todayLo === null)
            todayLo = periods[p].temperature;
          if (p > 0) {
            forecast.push({
              name: periods[p].name,
              temp: periods[p].temperature,
              condition: periods[p].shortForecast,
              isDaytime: periods[p].isDaytime,
            });
          }
        }
        if (todayHi !== null) cachedData.weather.data.tempMax = todayHi;
        if (todayLo !== null) cachedData.weather.data.tempMin = todayLo;
        cachedData.weather.data.forecast = forecast;
      }
    }

    cachedData.weather.lastFetch = now;
    console.log(
      "weather: " +
        cachedData.weather.data.temp +
        "\u00B0F, " +
        cachedData.weather.data.condition,
    );
    return cachedData.weather.data;
  } catch (err) {
    console.error("weather fetch error:", err.message);
    return cachedData.weather.data || {};
  }
}

// ===== SPACE STATUS =====
async function fetchSpaceStatus() {
  const now = Date.now();
  if (now - cachedData.spaceStatus.lastFetch < REFRESH_INTERVALS.spaceStatus) {
    return cachedData.spaceStatus.data;
  }

  try {
    const resp = await fetch("https://crashspacela.com/sign/");

    if (resp.ok) {
      const html = await resp.text();

      // parse the HTML
      // look for bgcolor in the table tag
      const isOpen =
        html.includes('bgcolor="#33FF33"') ||
        html.includes('bgcolor="#00FF00"');
      const isClosed = html.includes('bgcolor="#FF3333"');

      // extract message if present
      let message = "";
      const msgMatch = html.match(/message from (\w+): (.+?)</);
      if (msgMatch) {
        message = msgMatch[2];
      }

      // extract last update time from first table row
      let lastUpdate = "";
      const timeMatch = html.match(
        /<td>\s*(\d{4}-\d{2}-\d{2},\s*\d{1,2}:\d{2}\s*[ap]m)/,
      );
      if (timeMatch) {
        lastUpdate = timeMatch[1];
      }

      // extract closing time if open
      let closingTime = "";
      const closeMatch = html.match(
        /will close .+?at (\d{4}-\d{2}-\d{2},\s*\d{1,2}:\d{2}\s*[ap]m)/,
      );
      if (closeMatch) {
        closingTime = closeMatch[1];
      }

      // extract recent update history (last 5 button presses)
      var history = [];
      var rowRegex =
        /<tr><td>\s*(\w+)\s*<\/td><td>(\w+)<\/td><td>\s*(\d{4}-\d{2}-\d{2},\s*\d{1,2}:\d{2}\s*[ap]m)\s*<\/td><td>\s*(\d+)\s*<\/td><td>\s*(.+?)\s*<\/td><\/tr>/g;
      var rowMatch;
      while ((rowMatch = rowRegex.exec(html)) !== null) {
        history.push({
          time: rowMatch[3],
          minutes: parseInt(rowMatch[4]),
          message: rowMatch[5].trim(),
        });
      }

      cachedData.spaceStatus.data = {
        open: isOpen,
        closed: isClosed,
        message: message,
        lastUpdate: lastUpdate,
        closingTime: closingTime,
        history: history,
      };
      cachedData.spaceStatus.lastFetch = now;
    }

    return cachedData.spaceStatus.data;
  } catch (err) {
    console.error("space status fetch error:", err.message);
    return cachedData.spaceStatus.data;
  }
}

// ===== PRINTER DATA =====
async function fetchPrinterData() {
  const now = Date.now();
  if (now - cachedData.printers.lastFetch < REFRESH_INTERVALS.printers) {
    return cachedData.printers.data;
  }

  try {
    const resp = await fetch("http://archlinux:3001/");
      if (!resp.ok) {
      console.error("printer api error:", resp.status);
      return cachedData.printers.data;
    }

    cachedData.printers.data = await resp.json();
    cachedData.printers.lastFetch = now;
    console.log(
      `fetched printer data: ${Object.keys(cachedData.printers.data).length} printers`,
    );
    return cachedData.printers.data;
  } catch (err) {
    console.error("printer fetch error:", err.message);
    return cachedData.printers.data;
  }
}

// ===== API ENDPOINTS =====

// for ESP32 vfd
app.get("/api/buses", async (req, res) => {
  const buses = await fetchBusData();
  res.json({
    timestamp: Math.floor(Date.now() / 1000),
    departures: buses,
  });
});

// for web dashboard
app.get("/api/all", async (req, res) => {
  const [buses, calendar, weather, spaceStatus, printers] = await Promise.all([
    fetchBusData(),
    fetchCalendarData(),
    fetchWeatherData(),
    fetchSpaceStatus(),
    fetchPrinterData(),
  ]);

  res.json({
    buses,
    calendar,
    weather,
    spaceStatus,
    printers,
    timestamp: Math.floor(Date.now() / 1000),
  });
});

// start background refresh
setInterval(() => {
  fetchBusData();
  fetchCalendarData();
  fetchWeatherData();
  fetchSpaceStatus();
  fetchPrinterData();
}, 60 * 1000); // check every minute, each decides if it needs refresh

// initial fetch
(async () => {
  await Promise.all([
    fetchBusData(),
    fetchCalendarData(),
    fetchWeatherData(),
    fetchSpaceStatus(),
    fetchPrinterData(),
  ]);
  console.log("initial data loaded");
})();

app.listen(PORT, () => {
  console.log(`departure board server running on port ${PORT}`);
  console.log(`web ui: http://localhost:${PORT}`);
  console.log(`bus api: http://localhost:${PORT}/api/buses`);
});
